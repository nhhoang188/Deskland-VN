#version 300 es
precision highp float;

uniform sampler2D uNoise, uFA, uFB;
uniform vec2 uRes, uGrid;
uniform float uScale, uSeed, uStep, uMix, uTime, uDebug;

uniform vec4 uStyle;        // x=gloveStyle (0=Đỏ, 1=Tay áo tím GIF, 2=Găng mèo), y=backdrop (0=Văn phòng, 1=Tím GIF, 2=Võ đài), z=comboGlow, w=deskShake
uniform vec4 uHeadDef;      // x=dx, y=dy, z=rot (rad), w=squash (log-scale: <0 bẹp dọc phình ngang, >0 kéo giãn)
uniform vec4 uFaceWarp;     // x=dentX, y=dentY, z=pushX, w=pushY (biến dạng lõm/phình má cục bộ)
uniform vec4 uGlasses;      // x=dx, y=dy, z=rot lệch kính, w=hairWhip (độ văng tóc & kẹp ngọc trai)
uniform vec4 uTorsoDef;     // x=dx, y=dy, z=shearX, w=squash
uniform vec4 uRig2;         // x=armLeftJiggle, y=armRightJiggle, z=necklaceAngle, w=bodyDent
uniform vec4 uExpr;         // x=blink, y=wince (> <), z=dizzy (@ @), w=smileBoost
uniform vec4 uProps;        // x=mugHopY, y=mugTilt, z=hitFlash, w=comboCount
uniform vec4 uGloves[4];    // x, y (tọa độ CSS đầu găng), z=dir (rad), w=scaleAlpha
uniform vec4 uGloveMeta[4]; // x=origX, y=origY, z=phase (0..2), w=kind (0=ngang, 1=đập đỉnh đầu, 2=đấm thẳng)
uniform vec4 uPuffs[6];     // x, y (tọa độ CSS), z=age (0..1), w=seed (>0 đang hoạt động)

out vec4 o;

const float PI = 3.14159265;
const vec3 INK = vec3(0.125, 0.098, 0.115);

float hash1(float n) {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

float ss(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / max(k, 1e-4), 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0));
}

float sdEllipse(vec2 p, vec2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-4);
}

float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.80901699, -0.58778525);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

void strokeFill(inout vec3 col, float d, vec3 fillC, vec3 lineC, float lw, float aa) {
  float aOuter = ss(aa, -aa, d - lw);
  float aInner = ss(aa, -aa, d);
  col = mix(col, lineC, aOuter);
  col = mix(col, fillC, aInner);
}

// ---------- 1. Phối cảnh nền (Văn phòng vách kính mờ / Phông Tím GIF / Võ đài Boxing) ----------
vec3 drawBackdrop(vec2 p, float W, float H, float deskY, float s, float mode, float t) {
  vec2 uv = p / vec2(max(W, 1.0), max(H, 1.0));
  vec3 col;

  if (mode > 1.5) {
    // Võ đài Boxing buổi tối: ánh đèn spotlight rọi trung tâm, dây đài đỏ - xanh phía sau
    col = mix(vec3(0.085, 0.105, 0.165), vec3(0.145, 0.175, 0.255), 1.0 - uv.y);
    float spot = exp(-abs(p.x - W * 0.5) / (340.0 * s)) * ss(deskY + 40.0 * s, 0.0, p.y);
    col += vec3(0.20, 0.24, 0.34) * spot;

    // 3 sợi dây thừng võ đài căng ngang phía xa
    for (int r = 0; r < 3; r++) {
      float ry = deskY - (78.0 + float(r) * 62.0) * s + sin(p.x * 0.004) * 3.0 * s;
      float dRope = abs(p.y - ry) - 4.2 * s;
      vec3 ropeC = (r == 1) ? vec3(0.92, 0.94, 0.98) : ((r == 0) ? vec3(0.84, 0.22, 0.26) : vec3(0.20, 0.50, 0.88));
      col = mix(col, ropeC * 0.72, ss(1.5 * s, -0.5 * s, dRope) * 0.80);
    }
  } else if (mode > 0.5) {
    // Phông Tím Hoạt Hình chuẩn ảnh GIF mẫu (#413d65) + mây khói tròn bồng bềnh hai bên
    col = mix(vec3(0.245, 0.232, 0.388), vec3(0.285, 0.270, 0.445), 1.0 - uv.y * 0.7);
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      float side = mod(fi, 2.0) < 0.5 ? -1.0 : 1.0;
      float bx = W * 0.5 + side * (180.0 + mod(fi * 73.0, 420.0)) * s + sin(t * 0.8 + fi) * 14.0 * s;
      float by = deskY - mod(fi * 57.0 + t * 22.0, 340.0) * s;
      float br = (22.0 + mod(fi * 19.0, 44.0)) * s;
      float aBub = ss(br + 1.5 * s, br - 1.5 * s, length(p - vec2(bx, by)));
      col = mix(col, vec3(0.54, 0.52, 0.68), aBub * (0.14 + 0.10 * hash1(fi)));
    }
  } else {
    // Văn phòng sáng dịu lấy cảm hứng từ ảnh gốc (vách kính mờ sọc ngang + đèn trần ấm, rìa tối dịu tôn icon)
    col = mix(vec3(0.225, 0.255, 0.295), vec3(0.315, 0.348, 0.388), ss(1.0, 0.15, uv.y));
    float ceilY = H * 0.15;
    if (p.y < ceilY + 8.0 * s) {
      vec3 ceilC = mix(vec3(0.30, 0.29, 0.33), vec3(0.42, 0.40, 0.45), uv.y / 0.16);
      // Dải đèn hắt tím pastel nhẹ trên trần như trong ảnh gốc
      float ledStrip = exp(-abs(p.y - H * 0.045) / (14.0 * s));
      ceilC += vec3(0.18, 0.14, 0.26) * ledStrip;
      col = mix(col, ceilC, ss(ceilY + 2.0 * s, ceilY - 2.0 * s, p.y));
    }

    // Bóng đèn downlight tròn dịu trên trần & phản chiếu qua vách kính
    for (int k = 0; k < 4; k++) {
      float lx = W * (0.20 + float(k) * 0.20);
      float ly = H * 0.105;
      float dLight = length((p - vec2(lx, ly)) * vec2(0.75, 1.35));
      col += vec3(0.98, 0.95, 0.86) * exp(-dLight / (22.0 * s)) * 0.36;
      // Ánh phản chiếu mờ trên kính
      float dRef = length((p - vec2(lx, H * 0.24)) * vec2(0.8, 1.5));
      col += vec3(0.90, 0.94, 0.96) * exp(-dRef / (28.0 * s)) * 0.14;
    }

    // Dải kính mờ (frosted glass) chạy ngang giữa phòng với sọc trang trí hiện đại (không chữ/logo)
    float frostTop = H * 0.36, frostBot = deskY;
    if (p.y > frostTop - 4.0 * s && p.y < frostBot) {
      float inFrost = ss(frostTop - 2.0 * s, frostTop + 2.0 * s, p.y);
      vec3 frostC = vec3(0.42, 0.46, 0.49);
      float band1 = ss(3.0 * s, 0.5 * s, abs(p.y - (frostTop + 72.0 * s)));
      float band2 = ss(3.0 * s, 0.5 * s, abs(p.y - (frostTop + 88.0 * s)));
      float dash = step(0.35, fract(p.x / (26.0 * s)));
      frostC = mix(frostC, vec3(0.55, 0.59, 0.62), (band1 + band2 * dash) * 0.55);
      col = mix(col, frostC, inFrost * 0.42);
    }

    // Nẹp khung kính dọc mảnh tinh tế
    float mullion1 = abs(p.x - W * 0.28);
    float mullion2 = abs(p.x - W * 0.72);
    col = mix(col, col * 0.82, ss(2.2 * s, 0.5 * s, min(mullion1, mullion2)) * step(ceilY, p.y));

    // Quầng sáng trung tâm tôn gương mặt Chibi, hai mép màn hình dịu tối để chữ Icon trắng cực rõ
    float centerGlow = exp(-length((p - vec2(W * 0.5, deskY - 210.0 * s)) / vec2(440.0 * s, 320.0 * s)));
    col += vec3(0.11, 0.10, 0.09) * centerGlow;
    float edgeVig = ss(W * 0.24, W * 0.52, abs(p.x - W * 0.5));
    col *= 1.0 - 0.34 * edgeVig;
  }

  return col;
}

// ---------- 2. Vẽ chiếc Cốc Sứ Dưa Hấu dễ thương trên bàn gỗ ----------
void drawWatermelonMug(inout vec3 col, vec2 p, vec2 basePos, float s, float hopY, float tilt) {
  vec2 mp = (p - (basePos - vec2(0.0, hopY * s))) / s;
  if (abs(mp.x) > 70.0 || abs(mp.y + 34.0) > 62.0) return;

  // Bóng đổ trên mặt bàn (nhỏ lại khi cốc nảy cao)
  float dSh = sdEllipse(mp - vec2(2.0, 2.0 + hopY * 0.6), vec2(34.0, 7.5));
  col *= 1.0 - ss(2.5, -2.5, dSh) * clamp(0.32 - hopY * 0.006, 0.08, 0.32);

  vec2 q = rot(-tilt) * (mp - vec2(0.0, -30.0));

  // Quai cốc bên trái (như trong ảnh gốc)
  float dHandle = abs(sdEllipse(q - vec2(-31.0, 2.0), vec2(11.5, 15.5))) - 4.2;
  if (q.x < -22.0) {
    strokeFill(col, dHandle, vec3(0.48, 0.72, 0.18), INK, 2.2, 0.9);
  }

  // Thân cốc hơi thu đáy nhẹ
  vec2 bodyQ = q;
  bodyQ.x *= 1.0 + bodyQ.y * 0.0035;
  float dCup = sdBox(bodyQ, vec2(29.0, 27.0), 7.0);
  if (dCup < 4.0) {
    vec3 lime = vec3(0.55, 0.78, 0.20);
    // Các sọc vỏ dưa hấu xanh đậm uốn lượn dọc thân cốc
    float wave = sin(bodyQ.y * 0.32) * 2.2;
    float stripe = sin((bodyQ.x + wave) * 0.36);
    vec3 cupCol = mix(lime, vec3(0.24, 0.48, 0.14), ss(0.25, 0.65, stripe));
    // Khối sáng men sứ bóng
    cupCol = mix(cupCol, cupCol * 0.78, ss(6.0, 28.0, bodyQ.x));
    cupCol += vec3(0.24, 0.28, 0.18) * ss(5.5, 1.5, abs(bodyQ.x + 15.0)) * ss(22.0, 14.0, abs(bodyQ.y));
    strokeFill(col, dCup, cupCol, INK, 2.4, 0.9);

    // Miệng cốc sứ trắng phía trên
    float dRim = sdEllipse(q - vec2(0.0, -25.5), vec2(27.5, 5.2));
    strokeFill(col, dRim, vec3(0.95, 0.96, 0.93), INK, 1.8, 0.9);
  }
}

// ---------- 3. Vẽ Nhân Vật Chibi Miệng Cười (Biến dạng đàn hồi Squash & Stretch) ----------
void drawChibiCharacter(inout vec3 col, vec2 p, float W, float deskY, float s0, float t) {
  float s = s0 * 1.22;
  vec2 baseTorso = vec2(W * 0.5, deskY - 88.0 * s);
  vec2 baseHead  = vec2(W * 0.5, deskY - 252.0 * s);

  // Kiểm tra nhanh khung bao toàn nhân vật để tiết kiệm GPU ở vùng ngoài
  if (abs(p.x - W * 0.5) > 340.0 * s || p.y < deskY - 475.0 * s || p.y > deskY + 42.0 * s) return;

  // --- A. Ghế xoay văn phòng phía sau lưng ---
  vec2 cp = (p - vec2(W * 0.5, deskY - 96.0 * s)) / s;
  float dChairBack = sdBox(cp - vec2(0.0, -34.0), vec2(126.0, 112.0), 46.0);
  strokeFill(col, dChairBack, vec3(0.16, 0.18, 0.22), INK, 2.8, 1.0);
  // Tay vịn ghế hai bên như trong ảnh gốc
  float dArmRestL = sdSeg(cp, vec2(-132.0, 62.0), vec2(-112.0, 108.0)) - 11.0;
  float dArmRestR = sdSeg(cp, vec2( 132.0, 62.0), vec2( 112.0, 108.0)) - 11.0;
  strokeFill(col, min(dArmRestL, dArmRestR), vec3(0.22, 0.25, 0.30), INK, 2.5, 1.0);

  // --- B. Biến đổi đàn hồi Thân Áo Đen + Dây Chuyền Bạc + Hai Cánh Tay ---
  vec2 tp = (p - (baseTorso + uTorsoDef.xy * s)) / s;
  float tSy = exp(uTorsoDef.w);
  float tSx = exp(-uTorsoDef.w * 0.82);
  vec2 tq = tp;
  tq.x -= uTorsoDef.z * (85.0 - tq.y) * 0.55; // vặn/nghiêng vai
  tq.y = 88.0 + (tq.y - 88.0) / tSy;
  tq.x /= tSx;
  // Lõm ngực/bụng chữ C khi trúng đấm Body Shot
  tq.y -= uRig2.w * exp(- (tq.x * tq.x) / 5200.0);
  // Vai nhún theo lực đấm từng bên
  tq.y -= mix(uRig2.x, uRig2.y, clamp(tq.x / 180.0 + 0.5, 0.0, 1.0));

  // Tóc buộc đuôi ngựa thấp lấp ló sau cổ/vai
  vec2 ponyP = (p - (baseHead + uHeadDef.xy * s)) / s;
  ponyP.x -= uGlasses.w * 14.0;
  float dPony = sdEllipse(ponyP - vec2(18.0, 74.0), vec2(42.0, 34.0));
  strokeFill(col, dPony, vec3(0.27, 0.16, 0.11), INK, 2.8, 1.0);

  // Thân áo thun đen ngắn tay (Crew-neck Black T-Shirt)
  vec2 shirtQ = tq;
  shirtQ.x *= 1.0 - clamp(shirtQ.y, -70.0, 90.0) * 0.0012;
  float dTorso = sdBox(shirtQ - vec2(0.0, 16.0), vec2(84.0, 82.0), 38.0);
  float dSleeveL = sdBox(rot( 0.42) * (tq - vec2(-86.0, -18.0)), vec2(28.0, 34.0), 16.0);
  float dSleeveR = sdBox(rot(-0.42) * (tq - vec2( 86.0, -18.0)), vec2(28.0, 34.0), 16.0);
  float dShirt = smin(dTorso, min(dSleeveL, dSleeveR), 14.0);

  // Hai cánh tay Chibi hồng hào buông mềm xuống mép bàn (lắc lư dẻo như rubber-hose khi trúng đòn)
  float waveL = sin(t * 2.2) * 1.5 + uRig2.x * 0.75;
  float waveR = cos(t * 2.2) * 1.5 + uRig2.y * 0.75;
  float dArmL = sdSeg(tq, vec2(-92.0, -4.0), vec2(-98.0 - waveL * 0.5, 86.0)) - 21.5;
  float dArmR = sdSeg(tq, vec2( 92.0, -4.0), vec2( 98.0 + waveR * 0.5, 86.0)) - 21.5;
  vec3 skinBase = vec3(0.976, 0.816, 0.725);
  vec3 skinShade = vec3(0.925, 0.722, 0.625);
  vec3 armCol = mix(skinBase, skinShade, ss(-10.0, 35.0, abs(tq.x) - 85.0));
  strokeFill(col, min(dArmL, dArmR), armCol, INK, 2.8, 1.0);

  // Vẽ áo thun đen đè lên gốc cánh tay (tay áo phủ trên bắp tay)
  if (dShirt < 5.0) {
    vec3 shirtC = vec3(0.118, 0.128, 0.156);
    // Ánh khối mềm trên vai áo đen
    shirtC += vec3(0.055, 0.062, 0.078) * ss(20.0, -55.0, tq.y) * ss(95.0, 20.0, abs(tq.x));
    // Nếp gấp nhẹ ngang eo
    float fold = sin(tq.y * 0.22) * exp(-abs(tq.y - 48.0) / 26.0);
    shirtC += vec3(0.018) * fold;
    strokeFill(col, dShirt, shirtC, INK, 3.0, 1.0);

    // Viền bo cổ áo tròn màu đen đậm
    float dCollar = abs(sdEllipse(tq - vec2(0.0, -58.0), vec2(41.0, 24.0))) - 3.8;
    if (tq.y > -64.0) {
      col = mix(col, vec3(0.075, 0.082, 0.102), ss(1.0, -0.5, dCollar) * ss(1.0, -1.0, dShirt));
    }
  }

  // Cổ & vùng da xương quai xanh nối đầu với áo
  vec2 neckCenter = mix(baseTorso + vec2(0.0, -62.0 * s) + uTorsoDef.xy * s,
                        baseHead  + vec2(0.0,  78.0 * s) + uHeadDef.xy  * s, 0.45);
  vec2 np = (p - neckCenter) / s;
  np.x -= uHeadDef.x * 0.25;
  float dNeck = sdEllipse(np - vec2(0.0, 4.0), vec2(34.0, 32.0));
  // Giới hạn phần cổ nằm trong vùng cổ áo trên
  if (tq.y < -34.0) {
    vec3 neckCol = mix(skinBase, skinShade, ss(8.0, -16.0, np.y)); // bóng cằm đổ xuống cổ
    strokeFill(col, dNeck, neckCol, INK, 2.6, 1.0);
  }

  // Dây chuyền bạc mảnh chữ V + Mặt đá tròn xanh ngọc & giọt nước nhỏ (đung đưa như con lắc!)
  float nAng = uRig2.z;
  vec2 chainL = vec2(-32.0, -58.0);
  vec2 chainR = vec2( 32.0, -58.0);
  vec2 chainTip = vec2(sin(nAng) * 42.0, -56.0 + cos(nAng) * 52.0);
  float dChain = min(sdSeg(tq, chainL, chainTip), sdSeg(tq, chainR, chainTip));
  if (dShirt < -1.0 && tq.y > -62.0) {
    col = mix(col, vec3(0.88, 0.91, 0.96), ss(1.5, 0.3, dChain) * 0.92);
    // Mặt dây chuyền tròn chính
    float dPend1 = length(tq - (chainTip + vec2(0.0, 5.5))) - 5.2;
    strokeFill(col, dPend1, vec3(0.32, 0.78, 0.84), vec3(0.94, 0.96, 1.0), 1.8, 0.8);
    // Hạt charm nhỏ đính cạnh (đúng chi tiết dây chuyền trong ảnh gốc!)
    vec2 dropPos = chainTip + rot(nAng * 0.5) * vec2(8.5, -2.5);
    float dPend2 = sdEllipse(tq - dropPos, vec2(2.4, 3.8));
    col = mix(col, vec3(0.95, 0.97, 1.0), ss(0.8, -0.4, dPend2));
  }

  // --- C. Biến đổi đàn hồi ĐẦU CHIBI (Squash & Stretch + Lõm/Phình Má theo hướng đấm) ---
  vec2 hp = (p - (baseHead + uHeadDef.xy * s)) / s;
  vec2 hq = rot(-uHeadDef.z) * hp;

  // Co giãn thể tích quanh khớp cổ (+82): đấm từ trên xuống thì đầu bẹp lùn xuống vai & hai má phình ngang!
  float hSy = exp(uHeadDef.w);
  float hSx = exp(-uHeadDef.w * 0.86);
  hq.y = 82.0 + (hq.y - 82.0) / hSy;
  hq.x /= hSx;

  // Biến dạng lõm/phình bất đối xứng tại vùng má/mũi vừa trúng đấm
  vec2 dqDent = hq - uFaceWarp.xy;
  float dentFalloff = exp(-dot(dqDent, dqDent) / (78.0 * 78.0));
  hq -= uFaceWarp.zw * dentFalloff;
  // Độ méo dẻo ngang mặt kiểu hoạt hình GIF
  hq.x -= uFaceWarp.z * 0.20 * clamp((35.0 - hq.y) / 95.0, -1.0, 1.0);

  if (abs(hq.x) > 165.0 || abs(hq.y) > 155.0) return;

  float whip = uGlasses.w;
  vec3 hairDark = vec3(0.245, 0.142, 0.095);
  vec3 hairMain = vec3(0.375, 0.228, 0.152);
  vec3 hairHi   = vec3(0.535, 0.345, 0.232);

  // 1. Lớp tóc sau đầu & Đôi tai Chibi nhỏ nhắn
  float dBackHair = sdEllipse(hq - vec2(whip * 5.0, -10.0), vec2(106.0, 99.0));
  strokeFill(col, dBackHair, hairDark, INK, 3.0, 1.0);

  float dEarL = sdEllipse(hq - vec2(-96.0, 10.0), vec2(15.0, 20.0));
  float dEarR = sdEllipse(hq - vec2( 96.0, 10.0), vec2(15.0, 20.0));
  strokeFill(col, min(dEarL, dEarR), skinShade, INK, 2.8, 1.0);

  // 2. Khuôn mặt Chibi bầu bĩnh phúng phính (má bánh bao dễ thương)
  vec2 fq = hq;
  float cheekPuff = exp(-pow((fq.y - 24.0) / 38.0, 2.0)) * (8.5 + uExpr.w * 4.0);
  float faceW = 93.5 + cheekPuff - smoothstep(-20.0, -95.0, fq.y) * 8.0;
  float dFace = sdEllipse(fq - vec2(0.0, 2.0), vec2(faceW, 89.0));
  if (dFace < 5.0) {
    vec3 faceC = skinBase;
    // Khối má & cằm hồng ấm tự nhiên
    faceC = mix(faceC, skinShade, ss(52.0, 88.0, length(fq * vec2(0.88, 1.02))));
    faceC += vec3(0.03, 0.02, 0.015) * ss(55.0, 0.0, length(fq - vec2(0.0, -28.0)));

    // Đôi má ửng hồng Kawaii (đậm hơn khi bị đấm trêu!)
    float blushInt = 0.46 + 0.32 * uExpr.w;
    float bL = ss(24.0, 4.0, length((fq - vec2(-58.0, 24.0)) * vec2(0.82, 1.25)));
    float bR = ss(24.0, 4.0, length((fq - vec2( 58.0, 24.0)) * vec2(0.82, 1.25)));
    faceC = mix(faceC, vec3(0.965, 0.515, 0.565), (bL + bR) * blushInt);
    // Chấm sáng nhỏ long lanh trên gò má hồng
    float dotGlow = ss(3.2, 1.0, length(fq - vec2(-64.0, 21.0))) + ss(3.2, 1.0, length(fq - vec2(64.0, 21.0)));
    faceC = mix(faceC, vec3(1.0, 0.94, 0.95), dotGlow * 0.65);

    strokeFill(col, dFace, faceC, INK, 3.0, 1.0);
  }

  // 3. Chân mày nâu mềm mại
  float browLift = -uExpr.y * 3.0 + uExpr.w * 2.5;
  vec2 blP = hq - vec2(-40.0, -33.0 + browLift);
  vec2 brP = hq - vec2( 40.0, -33.0 + browLift);
  float dBrowL = sdSeg(blP, vec2(-18.0, 3.5 + blP.x * 0.08), vec2(17.0, 0.5)) - 2.6;
  float dBrowR = sdSeg(brP, vec2(-17.0, 0.5), vec2(18.0, 3.5 - brP.x * 0.08)) - 2.6;
  col = mix(col, hairDark, ss(0.9, -0.5, min(dBrowL, dBrowR)) * 0.92);

  // 4. Đôi Mắt Chibi Biểu Cảm (Mắt to long lanh / Nhắm cười > < / Xoắn ốc choáng @ @)
  for (int e = 0; e < 2; e++) {
    float side = (e == 0) ? -1.0 : 1.0;
    vec2 ep = hq - vec2(side * 39.0, -1.0);

    if (uExpr.z > 0.45) {
      // Mắt xoắn ốc hài hước (@ @) khi dính chuỗi đấm Combo liên hoàn!
      float r = length(ep);
      if (r < 19.0) {
        float a = atan(ep.y, ep.x) + t * 10.0 * side;
        float spiral = abs(fract((r * 0.16 + a / (2.0 * PI))) - 0.5) * 6.2;
        float mask = ss(17.5, 14.5, r);
        col = mix(col, INK, (1.0 - ss(0.8, 2.0, spiral)) * mask);
      }
    } else if (uExpr.y > 0.35 || uExpr.x > 0.65) {
      // Mắt nhắm tít cười tít mắt (> < khi trúng đòn hoặc nháy mắt tự nhiên)
      if (uExpr.y > 0.35) {
        vec2 wp = vec2(ep.x * (-side), ep.y);
        float dW1 = sdSeg(wp, vec2(-13.0, -8.5), vec2(9.0, 0.0)) - 2.7;
        float dW2 = sdSeg(wp, vec2(-13.0,  8.5), vec2(9.0, 0.0)) - 2.7;
        col = mix(col, INK, ss(0.9, -0.5, min(dW1, dW2)));
      } else {
        // Nháy mắt cong vui vẻ
        float arcY = -4.5 * (1.0 - (ep.x * ep.x) / 225.0);
        float dBlink = abs(ep.y - arcY) - 2.4;
        if (abs(ep.x) < 15.0) col = mix(col, INK, ss(0.9, -0.4, dBlink));
      }
    } else {
      // Đôi mắt Chibi nâu sẫm to tròn long lanh
      float openScale = clamp(1.0 - uExpr.x * 1.4, 0.15, 1.0);
      vec2 eq = vec2(ep.x, ep.y / openScale);
      float dWhite = sdEllipse(eq, vec2(17.5, 14.5));
      if (dWhite < 2.5) {
        col = mix(col, vec3(0.99, 0.99, 1.0), ss(1.0, -0.6, dWhite));
        // Con ngươi nâu ấm có chiều sâu
        float dIris = sdEllipse(eq - vec2(-side * 1.2, 0.5), vec2(12.2, 12.8));
        vec3 irisC = mix(vec3(0.14, 0.08, 0.06), vec3(0.38, 0.22, 0.14), ss(-4.0, 10.0, eq.y));
        col = mix(col, irisC, ss(0.9, -0.6, dIris));
        float dPupil = length(eq - vec2(-side * 1.2, 0.5)) - 6.2;
        col = mix(col, vec3(0.06, 0.04, 0.05), ss(0.9, -0.5, dPupil));
        // 2 đốm sáng trắng long lanh (anime catchlights)
        float hi1 = length(eq - vec2(-5.2, -4.6)) - 4.2;
        float hi2 = length(eq - vec2( 4.2,  4.2)) - 2.1;
        col = mix(col, vec3(1.0), ss(0.8, -0.5, min(hi1, hi2)));
        // Đường mí mắt trên dày cong quyến rũ
        float lashY = -12.5 + (ep.x * ep.x) * 0.022;
        float dLash = abs(ep.y - lashY * openScale) - 2.6;
        if (abs(ep.x) < 18.5) col = mix(col, INK, ss(0.9, -0.5, dLash));
      }
    }
  }

  // 5. Chiếc mũi nhỏ xinh & NỤ CƯỜI TƯƠI RẠNG RỠ LỘ RĂNG TRẮNG ("Chibi miệng cười")
  float dNose = sdEllipse(hq - vec2(0.0, 16.5), vec2(4.2, 2.8));
  col = mix(col, vec3(0.87, 0.61, 0.53), ss(1.0, -0.5, dNose) * 0.85);

  // Miệng cười luôn tươi rói (khi bị đấm càng co giãn toe toét đáng yêu hơn!)
  vec2 mq = hq - vec2(0.0, 42.0);
  float smileW = 36.0 + uExpr.w * 7.0;
  float smileH = 19.0 + uExpr.w * 5.0;
  // Đường môi trên hơi võng cười tươi, môi dưới cong sâu chữ D
  float topCurve = 0.0045 * mq.x * mq.x - 5.5;
  float botCurve = smileH - 0.0145 * mq.x * mq.x;
  float dMouthIn = max(topCurve - mq.y, mq.y - botCurve);
  float dMouthX = abs(mq.x) - smileW;
  float dMouth = max(dMouthIn, dMouthX);

  // Viền môi hồng đào đỏ tươi như son trong ảnh gốc
  vec3 lipColor = vec3(0.835, 0.315, 0.380);
  float dLipRing = dMouth - 3.6;
  if (dLipRing < 2.0) {
    col = mix(col, lipColor, ss(1.1, -0.5, dLipRing));
  }
  if (dMouth < 1.5) {
    float inM = ss(0.9, -0.6, dMouth);
    // Khoang miệng đỏ hồng + chiếc lưỡi nhỏ phía dưới
    vec3 inCol = vec3(0.62, 0.18, 0.24);
    float dTongue = length(mq - vec2(0.0, smileH + 2.0)) - 15.0;
    inCol = mix(inCol, vec3(0.93, 0.46, 0.52), ss(1.0, -1.0, dTongue));

    // Hàm răng trắng tinh rạng rỡ phía trên (đặc trưng nụ cười trong ảnh!)
    float teethBot = topCurve + 9.2;
    if (mq.y < teethBot + 1.5) {
      vec3 teethC = vec3(0.99, 0.995, 1.0);
      // Kẽ răng siêu nhẹ tinh tế
      float toothLine = abs(fract(mq.x / 8.5 + 0.5) - 0.5) * 8.5;
      teethC = mix(teethC, vec3(0.88, 0.90, 0.93), (1.0 - ss(0.3, 1.0, toothLine)) * 0.32);
      inCol = mix(inCol, teethC, ss(teethBot + 0.8, teethBot - 0.8, mq.y));
    }
    col = mix(col, inCol, inM);
    // Viền mảnh sắc nét quanh khuôn miệng cười
    col = mix(col, INK * 1.15, (1.0 - ss(0.5, 1.8, abs(dMouth))) * 0.78);
  }

  // 6. Mái Tóc Mái Thưa, Hai Lọn Tóc Mai Ôm Má & Kẹp Tóc Ngọc Trai Trắng
  // Vòm tóc đỉnh đầu
  float dCrown = max(sdEllipse(hq - vec2(0.0, -12.0), vec2(103.0, 96.0)), hq.y + 48.0 - (hq.x * hq.x) * 0.0028);
  if (dCrown < 3.0) {
    vec3 crCol = mix(hairMain, hairHi, ss(-35.0, -82.0, hq.y) * ss(75.0, 10.0, abs(hq.x)));
    // Vòng sáng bóng mượt trên tóc (anime angel-ring sheen)
    float sheen = ss(6.5, 1.5, abs(hq.y + 66.0 + (hq.x * hq.x) * 0.0022)) * ss(68.0, 22.0, abs(hq.x));
    crCol = mix(crCol, hairHi * 1.25, sheen * 0.55);
    strokeFill(col, dCrown, crCol, INK, 2.8, 1.0);
  }

  // 5 sợi tóc mái thưa mềm mại buông nhẹ qua trán (See-through Wispy Bangs, không viền đen cứng)
  float dBangsUnion = 999.0;
  float hBangs = 0.0;
  for (int b = 0; b < 5; b++) {
    float fb = float(b) - 2.0;
    float bx = fb * 19.5 + whip * 7.5 * (1.0 - abs(fb) * 0.14);
    vec2 aPt = vec2(fb * 14.5, -76.0);
    vec2 bPt = vec2(bx, -21.0 + abs(fb) * 4.2);
    vec2 pa = hq - aPt, ba = bPt - aPt;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    // Sợi mái thuôn nhọn mảnh dần về phía đuôi như sợi tóc thật
    float wStrand = mix(10.5, 0.9, pow(h, 1.35));
    float dStrand = length(pa - ba * h + vec2(sin(h * 3.14) * fb * 2.2, 0.0)) - wStrand;
    if (dStrand < dBangsUnion) {
      dBangsUnion = dStrand;
      hBangs = h;
    }
  }
  if (dBangsUnion < 5.0 && dFace < 2.0) {
    // Bóng mềm của tóc mái đổ nhẹ lên trán
    float dShBangs = dBangsUnion - 2.2;
    col = mix(col, col * 0.86, ss(2.2, -1.0, dShBangs) * 0.45);
    vec3 bangCol = mix(hairMain, hairHi, (1.0 - hBangs) * 0.65);
    bangCol = mix(bangCol, hairDark, ss(-1.2, 0.4, dBangsUnion) * 0.55);
    col = mix(col, bangCol, ss(0.85, -0.65, dBangsUnion));
  }

  // Hai lọn tóc mai uốn cong mềm ôm sát hai bên má (như ảnh gốc!)
  for (int sgn = -1; sgn <= 1; sgn += 2) {
    float fs = float(sgn);
    vec2 sp = hq - vec2(fs * 88.0 + whip * 9.5, 8.0);
    sp.x += fs * sin(clamp((sp.y + 55.0) / 130.0, 0.0, 1.0) * PI) * 8.5;
    float taper = mix(16.0, 2.0, clamp((sp.y + 55.0) / 135.0, 0.0, 1.0));
    float dLock = sdSeg(sp, vec2(-fs * 6.0, -56.0), vec2(fs * 4.0, 76.0)) - taper;
    strokeFill(col, dLock, mix(hairMain, hairDark, 0.32), INK, 2.2, 1.0);
  }

  // Chiếc Kẹp Tóc Đính 4 Hạt Ngọc Trai Trắng cài bên thái dương trái (đúng vị trí ảnh gốc!)
  vec2 clipP = rot(0.58 - whip * 0.15) * (hq - vec2(-75.0 + whip * 4.5, -55.0));
  float dClipBase = sdBox(clipP, vec2(18.5, 4.6), 4.2);
  if (dClipBase < 5.0) {
    strokeFill(col, dClipBase, vec3(0.88, 0.86, 0.82), INK, 1.8, 0.9);
    for (int k = 0; k < 4; k++) {
      float px = -11.2 + float(k) * 7.5;
      vec2 pp = clipP - vec2(px, 0.0);
      float dPearl = length(pp) - 3.9;
      vec3 pCol = mix(vec3(0.92, 0.90, 0.88), vec3(1.0, 0.995, 0.98), ss(3.8, -2.0, length(pp - vec2(-1.2, -1.2))));
      strokeFill(col, dPearl, pCol, vec3(0.58, 0.55, 0.52), 0.7, 0.7);
    }
  }

  // 7. Cặp Kính Gọng Đen Nửa Viền Mắt Mèo Đặc Trưng (lắc & lệch pha cực vui khi trúng đấm!)
  vec2 gq = rot(-uGlasses.z) * (hq - uGlasses.xy - vec2(0.0, -2.0));
  // Cầu kính bạc cong giữa sống mũi
  float bridgeArc = -6.0 + (gq.x * gq.x) * 0.035;
  if (abs(gq.x) < 12.5) {
    float dBridge = abs(gq.y - bridgeArc) - 1.9;
    col = mix(col, INK, ss(1.2, 0.0, dBridge - 0.8));
    col = mix(col, vec3(0.84, 0.87, 0.92), ss(0.8, -0.4, dBridge));
  }

  for (int sideI = -1; sideI <= 1; sideI += 2) {
    float fs = float(sideI);
    vec2 lp = gq - vec2(fs * 41.0, 0.0);
    // Dáng kính tròn hơi xếch nhẹ góc ngoài trên kiểu cat-eye thanh lịch
    vec2 lensShape = lp;
    lensShape.y += fs * lp.x * 0.065 * step(0.0, -lp.y);
    lensShape.x *= 1.0 - clamp(lp.y, -24.0, 26.0) * 0.0035;
    float dLens = sdBox(lensShape, vec2(30.5, 24.5), 21.5);

    if (dLens < 5.5) {
      // Mặt kính trong suốt có vệt phản quang chéo nhẹ
      if (dLens < 0.0) {
        float glint = ss(5.5, 1.0, abs(lp.x + lp.y * 0.75 + 6.0)) * 0.20
                    + ss(2.8, 0.5, abs(lp.x + lp.y * 0.75 - 5.0)) * 0.12;
        col += vec3(0.92, 0.97, 1.0) * glint * ss(0.0, -2.5, dLens);
      }
      // Viền dưới mảnh ánh bạc + Gọng trên đen bóng dày (Browline Frame đúng mẫu ảnh thật!)
      float isTopBrow = ss(2.0, -5.0, lp.y - fs * lp.x * 0.08);
      float rimThick = mix(1.45, 3.35, isTopBrow);
      float dRim = abs(dLens) - rimThick;
      vec3 rimCol = mix(vec3(0.80, 0.84, 0.89), vec3(0.10, 0.105, 0.135), isTopBrow);
      strokeFill(col, dRim, rimCol, INK, 0.85, 0.85);

      // Chấu bạc nhỏ ở hai góc gọng kính trên
      vec2 studPos = vec2(fs * 27.5, -15.5);
      float dStud = length(lp - studPos) - 2.1;
      col = mix(col, vec3(0.92, 0.95, 0.99), ss(0.8, -0.4, dStud));
    }
  }

  // 8. Ngôi sao vàng quay tít quanh đầu khi dính Combo liên hoàn!
  if (uStyle.z > 0.05) {
    for (int st = 0; st < 4; st++) {
      float ang = t * 4.2 + float(st) * (PI * 0.5);
      vec2 starPos = vec2(cos(ang) * 86.0, -96.0 + sin(ang) * 18.0);
      float dSt = sdStar5(rot(t * 3.0 + float(st)) * (hq - starPos), 11.5 * uStyle.z, 0.46);
      strokeFill(col, dSt, vec3(1.0, 0.86, 0.24), INK, 1.8, 0.85);
    }
  }
}

// ---------- 4. Hiệu ứng Khói Tròn Puff Hoạt Hình (giống GIF mẫu) & Tia Chấn Động ----------
void drawPuffBurst(inout vec3 col, vec2 p, vec4 puff, float s) {
  if (puff.w <= 0.01) return;
  float age = clamp(puff.z, 0.0, 1.0);
  vec2 dp = (p - puff.xy) / s;
  if (abs(dp.x) > 195.0 || abs(dp.y) > 195.0) return;

  float fade = (1.0 - age) * (1.0 - age);
  float seed = puff.w;

  // Vòng sóng xung kích hoạt hình lúc găng chạm mặt/thân
  if (age < 0.48) {
    float rRing = mix(20.0, 92.0, age / 0.48);
    float dRing = abs(length(dp) - rRing) - 3.2 * (1.0 - age * 1.7);
    col = mix(col, vec3(1.0, 0.96, 0.80), ss(1.1, -0.5, dRing) * (1.0 - age / 0.48) * 0.88);
  }

  // Chùm khói tròn trắng kem bồng bềnh tỏa ra giống hệt phong cách ảnh GIF mẫu số 2
  for (int k = 0; k < 8; k++) {
    float fk = float(k);
    float ang = fk * 0.7854 + seed * 6.28;
    float dist = (22.0 + (62.0 + 44.0 * hash1(seed + fk)) * pow(age, 0.56));
    vec2 cPos = vec2(cos(ang), sin(ang)) * dist - vec2(0.0, age * 22.0);
    float rad = (26.0 - age * 14.0) * (0.78 + 0.48 * hash1(fk * 3.1 + seed));
    float dC = length(dp - cPos) - max(rad, 2.0);
    col = mix(col, vec3(0.98, 0.985, 1.0), ss(1.4, -1.0, dC) * fade * 0.78);
  }

  // 3 ngôi sao vàng văng ra lúc mới va chạm (mờ dần mượt bằng alpha, không để lại chấm đen)
  if (age < 0.68) {
    float starAlpha = ss(0.68, 0.25, age);
    vec3 starLayer = col;
    for (int m = 0; m < 3; m++) {
      float fm = float(m);
      float ang = fm * 2.094 + seed * 3.7 + 0.4;
      vec2 sPos = vec2(cos(ang), sin(ang)) * (28.0 + 88.0 * pow(age, 0.62));
      float dStar = sdStar5(rot(age * 6.5 + fm) * (dp - sPos), 11.0, 0.46);
      strokeFill(starLayer, dStar, vec3(1.0, 0.85, 0.24), INK, 1.6, 0.9);
    }
    col = mix(col, starLayer, starAlpha);
  }
}

// ---------- 5. Vẽ Găng Tay Boxing / Cánh Tay Hoạt Hình GIF / Găng Chân Mèo ----------
void drawPunchGlove(inout vec3 col, vec2 p, vec4 glv, vec4 meta, float style, float s0) {
  if (glv.w <= 0.01) return;
  float s = s0 * 1.26;
  float retractU = clamp(meta.z - 1.2, 0.0, 1.0);
  float sc = (meta.z > 1.15) ? mix(1.08, 0.94, retractU) : clamp(glv.w, 0.72, 1.38);
  float alpha = (meta.z > 1.15) ? ss(1.0, 0.52, retractU) : clamp(glv.w * 1.45, 0.0, 1.0);
  vec2 tip = glv.xy;
  vec2 orig = meta.xy;
  float dir = glv.z;

  // Khung bao nhanh
  vec2 minB = min(tip, orig) - vec2(150.0 * s);
  vec2 maxB = max(tip, orig) + vec2(150.0 * s);
  if (p.x < minB.x || p.x > maxB.x || p.y < minB.y || p.y > maxB.y) return;

  vec3 layer = col;

  // Vệt gió tốc độ (Comic Swoosh & Speed Lines) phía sau găng tay
  if (meta.z < 1.18) {
    vec2 backDir = -vec2(cos(dir), sin(dir));
    vec2 perp = vec2(-backDir.y, backDir.x);
    for (int sl = -1; sl <= 1; sl++) {
      float off = float(sl) * 28.0 * s;
      float lenL = (sl == 0) ? 92.0 * s : 64.0 * s;
      vec2 sA = tip + backDir * 56.0 * s + perp * off;
      vec2 sB = sA + backDir * lenL;
      float dLine = sdSeg(p, sA, sB);
      layer = mix(layer, vec3(1.0, 0.98, 0.92), ss(2.6 * s, 0.3 * s, dLine) * (sl == 0 ? 0.62 : 0.45));
    }
  }

  // Tọa độ cục bộ của bàn tay/găng: +x hướng đấm tới mục tiêu, -x hướng về cổ tay
  vec2 q = (rot(-dir) * (p - tip)) / (s * max(sc, 0.35));

  if (style > 0.5 && style < 1.5) {
    // --- KIỂU 1: CÁNH TAY ÁO TÍM & NẮM ĐẤM HOẠT HÌNH PHẲNG GIỐNG ẢNH GIF MẪU SỐ 2! ---
    vec3 skinArm = vec3(0.992, 0.675, 0.455);
    vec3 sleeveC = vec3(0.735, 0.255, 0.785); // ống tay áo tím hồng hoạt hình

    float armCurve = sin(clamp(-q.x / 200.0, 0.0, 1.0) * 1.6) * 5.0;
    float wArm = mix(17.5, 22.5, clamp((-q.x - 20.0) / 150.0, 0.0, 1.0));
    float dArm = sdSeg(q - vec2(0.0, armCurve), vec2(-18.0, 0.0), vec2(-155.0, 0.0)) - wArm;
    strokeFill(layer, dArm, skinArm, INK, 2.6, 0.95);

    // Ống tay áo tím rộng kéo dài phía sau như ảnh GIF mẫu số 2
    float dSleeve = sdBox(q - vec2(-225.0, armCurve), vec2(95.0, 40.0), 6.0);
    if (dSleeve < 4.5) {
      vec3 slv = mix(sleeveC, sleeveC * 0.88, ss(-10.0, 28.0, q.y));
      strokeFill(layer, dSleeve, slv, INK, 2.8, 0.95);
    }

    // Nắm đấm hoạt hình 4 đốt ngón tay tròn bầu y hệt ảnh mẫu số 2
    float dPalm = sdBox(q - vec2(-8.0, 0.0), vec2(28.0, 32.0), 15.0);
    float dFist = dPalm;
    for (int f = 0; f < 4; f++) {
      float fy = -22.5 + float(f) * 15.0;
      float dKnuck = sdEllipse(q - vec2(16.0 - abs(float(f) - 1.5) * 2.2, fy), vec2(15.0, 9.8));
      dFist = smin(dFist, dKnuck, 4.5);
    }
    float dThumb = sdBox(rot(-0.25) * (q - vec2(-2.0, 30.0)), vec2(17.0, 10.0), 8.5);
    dFist = smin(dFist, dThumb, 5.0);
    strokeFill(layer, dFist, skinArm, INK, 2.8, 0.95);
  } else if (style > 1.5) {
    // --- KIỂU 2: GĂNG TAY CHÂN MÈO ĐỆM THỊT HỒNG DỄ THƯƠNG ---
    float dCuff = sdBox(q - vec2(-46.0, 0.0), vec2(18.0, 26.0), 8.0);
    strokeFill(layer, dCuff, vec3(0.98, 0.56, 0.68), INK, 2.8, 0.95);

    float dPaw = sdEllipse(q - vec2(-4.0, 0.0), vec2(38.0, 35.0));
    for (int tIdx = -1; tIdx <= 1; tIdx++) {
      dPaw = smin(dPaw, length(q - vec2(22.0 - abs(float(tIdx)) * 4.0, float(tIdx) * 19.0)) - 15.0, 7.0);
    }
    strokeFill(layer, dPaw, vec3(0.99, 0.97, 0.96), INK, 3.0, 0.95);
    vec3 beanC = vec3(0.98, 0.58, 0.68);
    float dMainPad = sdEllipse(q - vec2(-4.0, 0.0), vec2(14.0, 17.0));
    layer = mix(layer, beanC, ss(0.9, -0.5, dMainPad));
    for (int bIdx = -1; bIdx <= 1; bIdx++) {
      float dBean = length(q - vec2(18.0 - abs(float(bIdx)) * 3.0, float(bIdx) * 16.5)) - 6.5;
      layer = mix(layer, beanC, ss(0.9, -0.5, dBean));
    }
  } else {
    // --- KIỂU 0 (MẶC ĐỊNH): GĂNG TAY BOXING ĐỎ BÓNG BAY ĐỘC LẬP GỌN ĐẸP ---
    // Cổ găng quấn băng trắng viền vàng vô địch
    float dCuff = sdBox(q - vec2(-46.0, -1.0), vec2(18.0, 27.5), 8.5);
    if (dCuff < 4.5) {
      vec3 cuffC = vec3(0.97, 0.98, 1.0);
      float goldBand = ss(5.0, 2.0, abs(q.x + 46.0));
      cuffC = mix(cuffC, vec3(0.98, 0.76, 0.18), goldBand);
      strokeFill(layer, dCuff, cuffC, INK, 2.9, 0.95);
    }

    // Bầu găng tay Boxing đỏ căng phồng có ngón cái ôm bên cạnh
    float dMain = sdBox(q - vec2(0.0, -2.0), vec2(41.0, 35.5), 26.0);
    float dThumb = sdBox(rot(-0.28) * (q - vec2(-5.0, 29.0)), vec2(24.0, 14.5), 12.0);
    float dGlove = smin(dMain, dThumb, 6.5);
    if (dGlove < 4.5) {
      vec3 redBase = vec3(0.92, 0.18, 0.21);
      vec3 redShade = vec3(0.65, 0.09, 0.13);
      vec3 gCol = mix(redBase, redShade, ss(-10.0, 34.0, q.y));
      // Khối bóng da găng căng mọng
      float spec = ss(18.0, 2.0, length((q - vec2(10.0, -15.0)) * vec2(0.68, 1.28)));
      gCol = mix(gCol, vec3(1.0, 0.72, 0.70), spec * 0.72);
      strokeFill(layer, dGlove, gCol, INK, 3.0, 0.95);
      // Đường khâu nếp ngón cái
      float dCrease = sdSeg(q, vec2(-18.0, 17.0), vec2(14.0, 20.0)) - 1.6;
      layer = mix(layer, INK, ss(0.8, -0.4, dCrease) * 0.78);
    }
  }

  col = mix(col, layer, alpha);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y * uScale - gl_FragCoord.y) / uScale;
  float W = uRes.x, H = uRes.y;
  float s = min(W, H) / 900.0;
  float availH = max(280.0, H - 48.0);
  float deskY = availH * 0.80 + uStyle.w * s;
  float t = uTime;

  // 1. Nền bối cảnh
  vec3 col = drawBackdrop(p, W, H, deskY, s, uStyle.y, t);

  // 2. Nhân vật Chibi miệng cười (biến dạng đàn hồi Squash & Stretch theo lò xo)
  drawChibiCharacter(col, p, W, deskY, s, t);

  // 3. Mặt bàn làm việc gỗ sồi ấm áp phía trước (neo bố cục như mặt bàn trong ảnh GIF & ảnh gốc)
  if (p.y > deskY - 6.0 * s) {
    float dDeskTop = p.y - deskY;
    vec3 woodTop = (uStyle.y > 0.5 && uStyle.y < 1.5)
      ? vec3(0.95, 0.95, 0.94) // Đệm bàn trắng kem êm ái khi chọn Phông Tím GIF
      : vec3(0.835, 0.718, 0.596);
    vec3 woodEdge = (uStyle.y > 0.5 && uStyle.y < 1.5)
      ? vec3(0.76, 0.54, 0.42)
      : vec3(0.685, 0.548, 0.425);

    // Mặt ván bàn + vân gỗ mảnh
    float grain = sin(p.x * 0.015 + sin(p.y * 0.08) * 2.0) * 0.018;
    vec3 deskCol = mix(woodTop + grain, woodEdge, ss(22.0 * s, 26.0 * s, dDeskTop));
    col = mix(col, INK, ss(3.0 * s, 0.0, abs(dDeskTop) - 1.4 * s));
    col = mix(col, deskCol, ss(0.8 * s, -0.8 * s, -dDeskTop - 1.2 * s));
  }

  // 4. Chiếc cốc sứ dưa hấu xanh bên phải mặt bàn (nảy tưng khi bàn rung!)
  drawWatermelonMug(col, p, vec2(W * 0.5 + 290.0 * s, deskY + 8.0 * s), s * 1.12, uProps.x, uProps.y);

  // 5. Hiệu ứng khói tròn Puff & Sao văng tại các điểm trúng đòn
  for (int i = 0; i < 6; i++) {
    drawPuffBurst(col, p, uPuffs[i], s);
  }

  // 6. Các găng tay Boxing bay vào đấm theo Click hoặc chế độ Auto GIF
  for (int g = 0; g < 4; g++) {
    drawPunchGlove(col, p, uGloves[g], uGloveMeta[g], uStyle.x, s);
  }

  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}
