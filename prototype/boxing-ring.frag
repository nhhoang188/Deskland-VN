#version 300 es
// Deskland · Võ đài quyền anh (Arcade Boxing Ring)
// Dùng chung cho cả prototype/boxing-ring.html (WebGL2) và deskland-rs (OpenGL 3.3).
// Bối cảnh phòng tập & võ đài quyền anh Arcade góc nhìn 3/4, thảm tập ôm biểu tượng Desktop,
// hai võ sĩ đối kháng kết hợp hệ vật lý lò xo biến dạng đàn hồi Squash & Stretch, phóng găng đa vùng,
// khói tròn puff, sao choáng combo và đạo cụ phòng gym tương tác.
precision highp float;

uniform sampler2D uNoise, uFA, uFB;
uniform vec2 uRes, uGrid;
uniform float uScale, uSeed, uStep, uMix, uTime, uDebug;

uniform vec4 uScene;        // x=gloveStyle (0=Đỏ, 1=Hoạt hình, 2=Mèo), y=hudMode (0=Đầy đủ, 1=Gọn, 2=Ẩn), z=ringShake, w=ropeVib
uniform vec4 uHud;          // x=hp1, y=hp1Lag, z=hp2, w=hp2Lag (0..1)
uniform vec4 uRound;        // x=roundNum (1..12), y=roundSec (0..60), z=bellFlash (0..1), w=comboGlow (0..1)
uniform vec4 uGymProps;     // x=bagRedAng, y=bagDarkL_Ang, z=bagRightAng, w=tireSmash (0..1)

uniform vec4 uFPos[2];      // x=cx, y=cy (chân trên sàn bạt), z=bobY, w=lungeX
uniform vec4 uFHead[2];     // x=dx, y=dy, z=rot, w=squash (<0 bẹp dọc phình ngang, >0 kéo giãn)
uniform vec4 uFFace[2];     // x=dentX, y=dentY, z=pushX, w=pushY
uniform vec4 uFTorso[2];    // x=shear, y=squash, z=bodyDent (lõm chữ C), w=punchExt (0..1)
uniform vec4 uFExpr[2];     // x=blink, y=wince (> <), z=dizzy (@ @ + sao), w=hitFlash

uniform vec4 uGloves[4];    // x=gx, y=gy, z=dir (rad), w=scaleAlpha
uniform vec4 uGloveMeta[4]; // x=origX, y=origY, z=phase (0..2), w=kind (0=ngang, 1=búa đỉnh đầu, 2=đấm thẳng)
uniform vec4 uPuffs[6];     // x=px, y=py, z=age (0..1), w=seed (>0 đang hoạt động)

out vec4 o;

const float PI = 3.14159265;
const vec3 INK = vec3(0.095, 0.082, 0.105);

float hash1(float n) {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

float hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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

vec4 N(vec2 p, float sc) {
  return texture(uNoise, p / sc + uSeed * 0.013);
}

float fieldS(sampler2D t, vec2 p) {
  return texture(t, (p / uStep + 0.5) / uGrid).r;
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

float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }

float sdQuad(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 e0 = b - a, e1 = c - b, e2 = d - c, e3 = a - d;
  vec2 v0 = p - a, v1 = p - b, v2 = p - c, v3 = p - d;
  float d0 = sdSeg(p, a, b), d1 = sdSeg(p, b, c), d2 = sdSeg(p, c, d), d3 = sdSeg(p, d, a);
  float md = min(min(d0, d1), min(d2, d3));
  bool s0 = cross2(e0, v0) >= 0.0;
  bool s1 = cross2(e1, v1) >= 0.0;
  bool s2 = cross2(e2, v2) >= 0.0;
  bool s3 = cross2(e3, v3) >= 0.0;
  return (s0 && s1 && s2 && s3) ? -md : md;
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

// ---------------- 1. Tường gạch phòng tập, cửa sổ kính xanh teal & sàn thảm icon ----------------
vec3 drawGymRoom(vec2 p, float W, float H, float floorY, float s, float iconS) {
  float cx = W * 0.5;
  vec3 col;

  if (p.y < floorY) {
    // Tường gạch phòng gym cổ điển (tông xám nâu trầm kiểu Arcade)
    float vGrad = ss(0.0, floorY, p.y);
    col = mix(vec3(0.155, 0.142, 0.162), vec3(0.215, 0.192, 0.212), vGrad);

    // Mạch gạch ngang - dọc dịu nhẹ (rõ hơn ở trung tâm, dịu ở rìa để tôn icon)
    float brickH = 18.0 * s;
    float brickW = 42.0 * s;
    float row = floor(p.y / brickH);
    float bx = mod(p.x + mod(row, 2.0) * (brickW * 0.5), brickW);
    float by = mod(p.y, brickH);
    float mortar = max(ss(1.6 * s, 0.4 * s, min(bx, brickW - bx)), ss(1.6 * s, 0.4 * s, min(by, brickH - by)));
    float bTone = hash2(vec2(floor((p.x + mod(row, 2.0) * brickW * 0.5) / brickW), row)) - 0.5;
    col += bTone * 0.018;
    col = mix(col, vec3(0.115, 0.105, 0.122), mortar * 0.48);

    // Len chân tường gỗ sẫm
    float dTrim = abs(p.y - (floorY - 7.0 * s)) - 7.0 * s;
    if (dTrim < 2.0 * s) {
      strokeFill(col, dTrim, vec3(0.165, 0.135, 0.145), INK, 1.8 * s, 0.9 * s);
    }

    // 4 ô cửa sổ kính xanh teal cao đón nắng chéo (2 ô bên trái, 2 ô bên phải như pin gốc)
    float winTop = floorY * 0.20;
    float winBot = floorY * 0.66;
    float winCy = 0.5 * (winTop + winBot);
    float winHh = 0.5 * (winBot - winTop);
    float winHw = 30.0 * s;
    float winXs[4] = float[4](cx - 218.0 * s, cx - 134.0 * s, cx + 134.0 * s, cx + 218.0 * s);
    for (int i = 0; i < 4; i++) {
      vec2 wp = p - vec2(winXs[i], winCy);
      if (abs(wp.x) < winHw + 10.0 * s && abs(wp.y) < winHh + 10.0 * s) {
        float dFrame = sdBox(wp, vec2(winHw + 4.5 * s, winHh + 4.5 * s), 2.0 * s);
        strokeFill(col, dFrame, vec3(0.23, 0.21, 0.24), INK, 2.0 * s, 0.9 * s);
        float dGlass = sdBox(wp, vec2(winHw, winHh), 1.0 * s);
        if (dGlass < 1.5 * s) {
          vec3 glassC = mix(vec3(0.19, 0.64, 0.72), vec3(0.11, 0.44, 0.54), ss(-winHh, winHh, wp.y));
          // Vệt phản chiếu kính chéo trắng xanh
          float streak1 = ss(9.0 * s, 2.0 * s, abs(wp.x + wp.y * 0.52 + 8.0 * s));
          float streak2 = ss(4.5 * s, 1.0 * s, abs(wp.x + wp.y * 0.52 - 11.0 * s));
          glassC = mix(glassC, vec3(0.76, 0.95, 0.98), streak1 * 0.55 + streak2 * 0.42);
          // Thanh đố cửa chữ thập mảnh
          float mullion = min(abs(wp.x), abs(wp.y + 4.0 * s)) - 1.8 * s;
          glassC = mix(glassC, vec3(0.16, 0.18, 0.22), ss(0.9 * s, -0.4 * s, mullion));
          col = mix(col, glassC, ss(0.9 * s, -0.9 * s, dGlass));
        }
      }
      // Tia nắng dịu chiếu xiên từ ô cửa xuống tường
      vec2 rayP = p - vec2(winXs[i], winBot);
      if (rayP.y > -20.0 * s && rayP.y < 150.0 * s) {
        float rx = rayP.x - rayP.y * 0.28;
        float rayA = ss(winHw + 12.0 * s, winHw - 8.0 * s, abs(rx)) * ss(145.0 * s, 0.0, rayP.y);
        col += vec3(0.05, 0.10, 0.12) * rayA * 0.45;
      }
    }

    // 2 bóng đèn chao sắt / quả đấm tốc độ (speed-bag) treo giữa phòng tập
    for (int side = -1; side <= 1; side += 2) {
      float sx = cx + float(side) * 48.0 * s;
      float sy = floorY * 0.46;
      if (abs(p.x - sx) < 28.0 * s && p.y > floorY * 0.24 && p.y < sy + 32.0 * s) {
        // Giá gỗ gắn tường + trục treo
        float dBoard = sdBox(p - vec2(sx, sy - 22.0 * s), vec2(20.0 * s, 3.5 * s), 1.5 * s);
        strokeFill(col, dBoard, vec3(0.56, 0.34, 0.24), INK, 1.6 * s, 0.85 * s);
        float sway = sin(uTime * 3.4 + float(side)) * 0.10;
        vec2 bagQ = rot(-sway) * (p - vec2(sx, sy - 18.0 * s));
        float dPear = sdEllipse(bagQ - vec2(0.0, 16.0 * s), vec2(9.5 * s, 13.5 * s));
        strokeFill(col, dPear, vec3(0.32, 0.29, 0.40), INK, 1.8 * s, 0.85 * s);
      }
    }
  } else {
    // Sàn phòng tập lát gỗ/thảm cao su tối màu có chiều sâu
    float fGrad = ss(floorY, H, p.y);
    col = mix(vec3(0.185, 0.168, 0.195), vec3(0.125, 0.115, 0.138), fGrad);
    float plank = abs(fract((p.y - floorY) / (22.0 * s)) - 0.5);
    col = mix(col, col * 0.88, ss(0.47, 0.50, plank) * 0.55);
  }

  // Ánh đèn spotlight trần rọi ấm xuống trung tâm võ đài
  float spot = exp(-abs(p.x - cx) / (360.0 * s)) * ss(H, floorY * 0.1, p.y);
  col += vec3(0.075, 0.072, 0.095) * spot;

  // Thảm cao su EVA tối màu ôm gọn quanh các biểu tượng Desktop (fieldS < 0)
  if (iconS < 18.0) {
    float matMask = ss(3.0, -2.0, iconS);
    float rimMask = ss(3.5, 0.5, abs(iconS + 2.0));
    vec3 matBase = (p.y < floorY) ? vec3(0.125, 0.135, 0.168) : vec3(0.118, 0.128, 0.160);
    // Vân caro nhám cực nhẹ của thảm tập
    float tex = sin(p.x * 0.35) * sin(p.y * 0.35) * 0.008;
    col = mix(col, matBase + tex, matMask * 0.86);
    col = mix(col, vec3(0.28, 0.35, 0.46), rimMask * 0.55);
  }

  return col;
}

// ---------------- 2. Đạo cụ phòng tập (Ghế băng, Kệ tạ, Bao cát treo, Lốp xe & Búa, Tạ chuông) ----------------
void drawDumbbellPair(inout vec3 col, vec2 p, vec2 c, float s, float ang, vec3 plateC) {
  vec2 q = rot(ang) * (p - c);
  if (abs(q.x) > 22.0 * s || abs(q.y) > 14.0 * s) return;
  float dBar = sdSeg(q, vec2(-8.0 * s, 0.0), vec2(8.0 * s, 0.0)) - 2.0 * s;
  strokeFill(col, dBar, vec3(0.72, 0.76, 0.82), INK, 1.4 * s, 0.85 * s);
  float dL = sdBox(q - vec2(-9.5 * s, 0.0), vec2(3.8 * s, 6.8 * s), 1.8 * s);
  float dR = sdBox(q - vec2(9.5 * s, 0.0), vec2(3.8 * s, 6.8 * s), 1.8 * s);
  strokeFill(col, min(dL, dR), plateC, INK, 1.5 * s, 0.85 * s);
}

void drawHangingBag(inout vec3 col, vec2 p, vec2 pivot, float len, float rad, float ang, int style, float s) {
  // Kiểm tra nhanh khung bao trước khi tính SDF
  if (abs(p.x - pivot.x) > (len * 0.55 + rad * 2.4) || p.y < pivot.y - 36.0 * s || p.y > pivot.y + len + rad * 2.0) return;

  vec2 q = rot(-ang) * (p - pivot);
  // Dây xích sắt đôi treo chữ V ngược
  float dChain1 = sdSeg(q, vec2(0.0, 0.0), vec2(-rad * 0.58, 26.0 * s)) - 1.4 * s;
  float dChain2 = sdSeg(q, vec2(0.0, 0.0), vec2(rad * 0.58, 26.0 * s)) - 1.4 * s;
  strokeFill(col, min(dChain1, dChain2), vec3(0.66, 0.70, 0.78), INK, 1.2 * s, 0.85 * s);

  // Bầu bao cát hơi cong nhẹ ở bụng khi đang văng mạnh
  float bend = clamp(ang * 18.0 * s, -9.0 * s, 9.0 * s);
  vec2 bq = q - vec2(bend * sin(clamp((q.y - 26.0 * s) / max(len - 26.0 * s, 1.0), 0.0, 1.0) * PI), 26.0 * s + (len - 26.0 * s) * 0.5);
  float halfH = (len - 26.0 * s) * 0.5;
  float dBag = sdBox(bq, vec2(rad, halfH), rad * 0.42);
  if (dBag < 3.5 * s) {
    vec3 baseC = (style == 0) ? vec3(0.76, 0.24, 0.24) : vec3(0.22, 0.21, 0.30);
    vec3 shadeC = baseC * 0.68;
    vec3 bagC = mix(baseC, shadeC, ss(-rad * 0.5, rad * 0.9, bq.x));
    // Băng keo quấn đầu/cuối bao cát
    float bandTop = ss(4.5 * s, 3.0 * s, abs(bq.y + halfH * 0.62));
    float bandBot = ss(4.5 * s, 3.0 * s, abs(bq.y - halfH * 0.65));
    vec3 tapeC = (style == 0) ? vec3(0.88, 0.86, 0.84) : vec3(0.55, 0.56, 0.64);
    bagC = mix(bagC, tapeC, max(bandTop, bandBot) * 0.88);
    // Dấu băng keo chữ X đặc trưng trên bao cát đỏ (giống pin gốc!)
    if (style == 0) {
      vec2 xp = bq - vec2(2.0 * s, 2.0 * s);
      float dx1 = sdSeg(xp, vec2(-8.0 * s, -9.0 * s), vec2(8.0 * s, 9.0 * s)) - 2.1 * s;
      float dx2 = sdSeg(xp, vec2(8.0 * s, -9.0 * s), vec2(-8.0 * s, 9.0 * s)) - 2.1 * s;
      bagC = mix(bagC, vec3(0.92, 0.89, 0.86), ss(0.8 * s, -0.4 * s, min(dx1, dx2)));
    }
    // Bóng sáng dọc thân da
    float spec = ss(rad * 0.35, 0.0, abs(bq.x + rad * 0.38)) * ss(halfH * 0.85, halfH * 0.2, abs(bq.y));
    bagC += vec3(0.12) * spec;
    strokeFill(col, dBag, bagC, INK, 2.2 * s, 0.9 * s);
  }
}

void drawGymPropsBack(inout vec3 col, vec2 p, float W, float availH, float floorY, float s) {
  float cx = W * 0.5;

  // 1. Kệ để tạ đơn 2 tầng (bên trái sau)
  vec2 rackC = vec2(cx - 295.0 * s, floorY - 6.0 * s);
  if (abs(p.x - rackC.x) < 62.0 * s && abs(p.y - rackC.y) < 44.0 * s) {
    float dLegL = sdSeg(p, rackC + vec2(-42.0 * s, -26.0 * s), rackC + vec2(-48.0 * s, 24.0 * s)) - 3.0 * s;
    float dLegR = sdSeg(p, rackC + vec2(42.0 * s, -26.0 * s), rackC + vec2(48.0 * s, 24.0 * s)) - 3.0 * s;
    float dShelf1 = sdSeg(p, rackC + vec2(-44.0 * s, -16.0 * s), rackC + vec2(44.0 * s, -16.0 * s)) - 2.6 * s;
    float dShelf2 = sdSeg(p, rackC + vec2(-46.0 * s, 4.0 * s), rackC + vec2(46.0 * s, 4.0 * s)) - 2.6 * s;
    strokeFill(col, min(min(dLegL, dLegR), min(dShelf1, dShelf2)), vec3(0.32, 0.35, 0.44), INK, 1.6 * s, 0.85 * s);
    for (int k = -1; k <= 1; k++) {
      drawDumbbellPair(col, p, rackC + vec2(float(k) * 24.0 * s, -22.0 * s), s * 0.72, 0.0, vec3(0.62, 0.72, 0.86));
      drawDumbbellPair(col, p, rackC + vec2(float(k) * 25.0 * s, -2.0 * s), s * 0.82, 0.0, vec3(0.46, 0.54, 0.68));
    }
  }
  // Cặp tạ tay rời trên sàn
  drawDumbbellPair(col, p, vec2(cx - 228.0 * s, floorY + 26.0 * s), s * 0.78, 0.35, vec3(0.68, 0.78, 0.90));
  drawDumbbellPair(col, p, vec2(cx + 195.0 * s, floorY + 20.0 * s), s * 0.78, -0.28, vec3(0.68, 0.78, 0.90));

  // 2. Ghế băng gỗ tập luyện phía sau đài
  vec2 benchC = vec2(cx - 48.0 * s, floorY + 4.0 * s);
  if (abs(p.x - benchC.x) < 68.0 * s && abs(p.y - benchC.y) < 26.0 * s) {
    float dBLeg1 = sdBox(p - (benchC + vec2(-42.0 * s, 9.0 * s)), vec2(4.0 * s, 9.0 * s), 1.0 * s);
    float dBLeg2 = sdBox(p - (benchC + vec2(42.0 * s, 9.0 * s)), vec2(4.0 * s, 9.0 * s), 1.0 * s);
    strokeFill(col, min(dBLeg1, dBLeg2), vec3(0.24, 0.24, 0.30), INK, 1.5 * s, 0.85 * s);
    float dSeat = sdBox(p - (benchC + vec2(0.0, -2.0 * s)), vec2(56.0 * s, 6.0 * s), 2.0 * s);
    strokeFill(col, dSeat, vec3(0.72, 0.39, 0.28), INK, 1.8 * s, 0.85 * s);
  }

  // 3. Dây nhảy cuộn trên sàn (phía sau bên phải ghế băng)
  vec2 ropeC = vec2(cx + 245.0 * s, floorY + 26.0 * s);
  if (abs(p.x - ropeC.x) < 34.0 * s && abs(p.y - ropeC.y) < 18.0 * s) {
    float dLoop = abs(sdEllipse(p - ropeC, vec2(20.0 * s, 7.5 * s))) - 1.5 * s;
    strokeFill(col, dLoop, vec3(0.88, 0.88, 0.92), INK, 1.1 * s, 0.85 * s);
    float dH1 = sdBox(p - (ropeC + vec2(-18.0 * s, 5.0 * s)), vec2(5.5 * s, 2.2 * s), 1.0 * s);
    float dH2 = sdBox(p - (ropeC + vec2(16.0 * s, -5.0 * s)), vec2(5.5 * s, 2.2 * s), 1.0 * s);
    strokeFill(col, min(dH1, dH2), vec3(0.84, 0.28, 0.28), INK, 1.2 * s, 0.85 * s);
  }

  // 4. Khung giá chữ L đỏ + Bao cát đỏ dán chữ X (trái-sau) & Bao cát đen (trái-trước)
  vec2 stand1 = vec2(cx - 388.0 * s, availH * 0.18);
  if (p.x > cx - 455.0 * s && p.x < cx - 340.0 * s && p.y > availH * 0.15 && p.y < floorY + 55.0 * s) {
    float dPole = sdSeg(p, vec2(stand1.x - 36.0 * s, floorY + 38.0 * s), vec2(stand1.x - 36.0 * s, stand1.y)) - 4.2 * s;
    float dArm = sdSeg(p, vec2(stand1.x - 36.0 * s, stand1.y), stand1) - 4.0 * s;
    float dBase = sdBox(p - vec2(stand1.x - 36.0 * s, floorY + 40.0 * s), vec2(16.0 * s, 4.5 * s), 2.0 * s);
    strokeFill(col, min(min(dPole, dArm), dBase), vec3(0.62, 0.25, 0.26), INK, 1.8 * s, 0.85 * s);
  }
  drawHangingBag(col, p, stand1, 138.0 * s, 19.5 * s, uGymProps.x, 0, s);

  vec2 stand2 = vec2(cx - 448.0 * s, availH * 0.29);
  if (p.x > cx - 515.0 * s && p.x < cx - 405.0 * s && p.y > availH * 0.26 && p.y < availH * 0.72) {
    float dPole2 = sdSeg(p, vec2(stand2.x - 34.0 * s, availH * 0.68), vec2(stand2.x - 34.0 * s, stand2.y)) - 4.2 * s;
    float dArm2 = sdSeg(p, vec2(stand2.x - 34.0 * s, stand2.y), stand2) - 4.0 * s;
    float dBase2 = sdBox(p - vec2(stand2.x - 34.0 * s, availH * 0.69), vec2(17.0 * s, 4.8 * s), 2.0 * s);
    strokeFill(col, min(min(dPole2, dArm2), dBase2), vec3(0.56, 0.24, 0.26), INK, 1.8 * s, 0.85 * s);
  }
  drawHangingBag(col, p, stand2, 146.0 * s, 21.0 * s, uGymProps.y, 1, s);

  // 5. Bao cát đen treo bên phải võ đài
  vec2 standR = vec2(cx + 425.0 * s, availH * 0.24);
  if (p.x > cx + 380.0 * s && p.x < cx + 495.0 * s && p.y > availH * 0.20 && p.y < availH * 0.68) {
    float dArmR = sdSeg(p, standR, vec2(standR.x + 42.0 * s, standR.y)) - 4.0 * s;
    float dBraceR = sdSeg(p, standR + vec2(12.0 * s, 0.0), vec2(standR.x + 42.0 * s, standR.y + 26.0 * s)) - 3.0 * s;
    strokeFill(col, min(dArmR, dBraceR), vec3(0.58, 0.25, 0.26), INK, 1.8 * s, 0.85 * s);
  }
  drawHangingBag(col, p, standR, 148.0 * s, 21.5 * s, uGymProps.z, 1, s);
}

void drawGymPropsFront(inout vec3 col, vec2 p, float W, float availH, float s) {
  float cx = W * 0.5;

  // 1. Lốp xe tải lớn + Búa tạ cán gỗ ở góc dưới trái (Click để bổ búa làm lốp nảy Squash & Stretch!)
  vec2 tireC = vec2(cx - 420.0 * s, availH * 0.845);
  if (abs(p.x - tireC.x) < 88.0 * s && abs(p.y - tireC.y) < 68.0 * s) {
    float smash = uGymProps.w; // 0..1 khi đang đập búa
    float squash = (smash > 0.0) ? sin(smash * PI * 2.5) * exp(-smash * 3.0) * 0.26 : 0.0;
    vec2 tp = p - tireC + vec2(0.0, squash * 12.0 * s);
    tp.x /= (1.0 + squash * 0.85);
    tp.y /= max(0.55, 1.0 - squash);

    // Thân lốp cao su đen dày 3D + lỗ mâm giữa
    float dOuterBot = sdEllipse(tp - vec2(0.0, 12.0 * s), vec2(44.0 * s, 22.0 * s));
    float dOuterTop = sdEllipse(tp, vec2(44.0 * s, 21.0 * s));
    float dSide = max(tp.y - 12.0 * s, max(-tp.y, abs(tp.x) - 44.0 * s));
    float dTire = min(min(dOuterTop, dOuterBot), dSide);
    if (dTire < 3.0 * s) {
      vec3 rubber = mix(vec3(0.20, 0.19, 0.22), vec3(0.12, 0.11, 0.14), ss(-16.0 * s, 24.0 * s, tp.y));
      // Vân gai lốp
      float tread = sin(atan(tp.y, tp.x) * 18.0) * 0.025;
      rubber += tread;
      strokeFill(col, dTire, rubber, INK, 2.2 * s, 0.9 * s);
      float dRim = sdEllipse(tp, vec2(20.0 * s, 9.0 * s));
      strokeFill(col, dRim, vec3(0.09, 0.08, 0.10), INK, 1.6 * s, 0.85 * s);
    }

    // Búa tạ cán gỗ (xoay bổ xuống lốp khi smash > 0)
    float hamAng = -0.52;
    if (smash > 0.001) {
      float swing = (smash < 0.22) ? (smash / 0.22) : max(0.0, 1.0 - (smash - 0.22) / 0.78);
      hamAng = mix(-0.52, 0.62, swing);
    }
    vec2 hPivot = tireC + vec2(48.0 * s, 26.0 * s);
    vec2 hq = rot(-hamAng) * (p - hPivot);
    float dHandle = sdSeg(hq, vec2(0.0, 0.0), vec2(-58.0 * s, -18.0 * s)) - 3.0 * s;
    strokeFill(col, dHandle, vec3(0.68, 0.46, 0.30), INK, 1.6 * s, 0.85 * s);
    vec2 headQ = rot(0.30) * (hq - vec2(-58.0 * s, -18.0 * s));
    float dHead = sdBox(headQ, vec2(8.5 * s, 14.0 * s), 2.5 * s);
    strokeFill(col, dHead, vec3(0.42, 0.45, 0.52), INK, 1.8 * s, 0.85 * s);
  }

  // 2. Nhóm tạ chuông (Kettlebells) & Bóng tạ đỏ ở góc phải
  vec2 kbBase = vec2(cx + 422.0 * s, availH * 0.70);
  if (abs(p.x - kbBase.x) < 65.0 * s && abs(p.y - kbBase.y) < 42.0 * s) {
    vec2 offs[3] = vec2[3](vec2(-18.0 * s, -6.0 * s), vec2(16.0 * s, 2.0 * s), vec2(-2.0 * s, 14.0 * s));
    for (int k = 0; k < 3; k++) {
      vec2 kp = p - (kbBase + offs[k]);
      float dHandle = abs(length(kp - vec2(0.0, -9.5 * s)) - 6.2 * s) - 2.0 * s;
      strokeFill(col, dHandle, vec3(0.32, 0.34, 0.40), INK, 1.3 * s, 0.85 * s);
      float dBall = length(kp) - 10.5 * s;
      strokeFill(col, dBall, vec3(0.18, 0.19, 0.24), INK, 1.8 * s, 0.85 * s);
    }
  }
  vec2 medC = vec2(cx + 436.0 * s, availH * 0.855);
  if (abs(p.x - medC.x) < 40.0 * s && abs(p.y - medC.y) < 40.0 * s) {
    float dShadow = sdEllipse(p - (medC + vec2(0.0, 22.0 * s)), vec2(26.0 * s, 7.0 * s));
    col = mix(col, INK, ss(1.5 * s, -1.5 * s, dShadow) * 0.35);
    float dMed = length(p - medC) - 24.0 * s;
    if (dMed < 3.0 * s) {
      vec3 medCol = mix(vec3(0.76, 0.26, 0.28), vec3(0.46, 0.15, 0.18), ss(-14.0 * s, 20.0 * s, p.y - medC.y));
      float stripe = ss(4.5 * s, 2.5 * s, abs((p.x - medC.x) * 0.5 + (p.y - medC.y) * 0.86));
      medCol = mix(medCol, vec3(0.25, 0.14, 0.18), stripe * 0.45);
      strokeFill(col, dMed, medCol, INK, 2.2 * s, 0.9 * s);
    }
  }
}

// ---------------- 3. Võ đài quyền anh nâng cao góc nhìn 3/4 (Sàn bạt xanh, Trụ & Dây thừng đàn hồi) ----------------
struct RingGeom {
  vec2 bl; // Back-Left trên mặt sàn
  vec2 br; // Back-Right trên mặt sàn
  vec2 fr; // Front-Right trên mặt sàn
  vec2 fl; // Front-Left trên mặt sàn
};

RingGeom makeRing(float W, float availH, float s, float shakeY) {
  float cx = W * 0.5;
  float yBack = availH * 0.595 + shakeY;
  float yFront = availH * 0.848 + shakeY;
  float hwBack = 252.0 * s;
  float hwFront = 318.0 * s;
  return RingGeom(
    vec2(cx - hwBack, yBack),
    vec2(cx + hwBack, yBack),
    vec2(cx + hwFront, yFront),
    vec2(cx - hwFront, yFront)
  );
}

void drawRingBaseAndBackRopes(inout vec3 col, vec2 p, RingGeom rg, float W, float s, float ropeVib) {
  float cx = W * 0.5;
  // Kiểm tra nhanh phạm vi võ đài
  if (abs(p.x - cx) > 350.0 * s || p.y < rg.bl.y - 105.0 * s || p.y > rg.fl.y + 62.0 * s) return;

  // Bóng đổ lớn của bục võ đài xuống sàn phòng gym
  float dRingShadow = sdQuad(
    p,
    rg.bl + vec2(-12.0 * s, 18.0 * s),
    rg.br + vec2(12.0 * s, 18.0 * s),
    rg.fr + vec2(18.0 * s, 52.0 * s),
    rg.fl + vec2(-18.0 * s, 52.0 * s)
  );
  col = mix(col, vec3(0.05, 0.04, 0.06), ss(8.0 * s, -4.0 * s, dRingShadow) * 0.55);

  // Tấm yếm bục võ đài phía trước (Apron Skirt)
  float apronH = 42.0 * s;
  float dApron = sdQuad(p, rg.fl, rg.fr, rg.fr + vec2(0.0, apronH), rg.fl + vec2(0.0, apronH));
  if (dApron < 3.0 * s) {
    vec3 apC = mix(vec3(0.14, 0.20, 0.36), vec3(0.09, 0.13, 0.25), ss(rg.fl.y, rg.fl.y + apronH, p.y));
    float pleat = sin((p.x - cx) / (18.0 * s)) * 0.018;
    strokeFill(col, dApron, apC + pleat, INK, 2.4 * s, 0.9 * s);
    // Viền vàng/đỏ ngang thân bục
    float trim = ss(3.0 * s, 1.2 * s, abs(p.y - (rg.fl.y + 8.0 * s)));
    col = mix(col, vec3(0.72, 0.24, 0.26), trim * ss(0.5 * s, -0.5 * s, dApron) * 0.75);
  }

  // Mặt sàn bạt xanh navy (3/4 Trapezoid)
  float dCanvas = sdQuad(p, rg.bl, rg.br, rg.fr, rg.fl);
  if (dCanvas < 3.0 * s) {
    vec3 matOuter = vec3(0.135, 0.215, 0.395);
    vec3 matInner = vec3(0.175, 0.285, 0.515);
    float dInner = sdQuad(
      p,
      rg.bl + vec2(26.0 * s, 16.0 * s),
      rg.br + vec2(-26.0 * s, 16.0 * s),
      rg.fr + vec2(-32.0 * s, -18.0 * s),
      rg.fl + vec2(32.0 * s, -18.0 * s)
    );
    vec3 cMat = mix(matOuter, matInner, ss(2.0 * s, -2.0 * s, dInner));
    // Đường kẻ viền trong của mặt sàn đài
    float innerLine = ss(2.2 * s, 0.6 * s, abs(dInner));
    cMat = mix(cMat, vec3(0.28, 0.42, 0.68), innerLine * 0.65);
    // Ánh đèn trần rọi giữa sàn đài + vân vải bạt nhẹ
    float ringSpot = exp(-length((p - vec2(cx, mix(rg.bl.y, rg.fl.y, 0.52))) * vec2(0.75, 1.6)) / (170.0 * s));
    cMat += vec3(0.06, 0.09, 0.14) * ringSpot;
    cMat += (N(p, 90.0 * s).r - 0.5) * 0.025;
    strokeFill(col, dCanvas, cMat, INK, 2.4 * s, 0.9 * s);
  }

  // Bậc thang gỗ 2 bậc bước lên võ đài ở góc trái-trước (giống hệt pin gốc!)
  vec2 stC = vec2(rg.fl.x + 62.0 * s, rg.fl.y + 34.0 * s);
  if (abs(p.x - stC.x) < 42.0 * s && abs(p.y - stC.y) < 28.0 * s) {
    float dStep1 = sdBox(p - (stC + vec2(0.0, -7.0 * s)), vec2(26.0 * s, 7.5 * s), 1.5 * s);
    float dStep2 = sdBox(p - (stC + vec2(0.0, 7.0 * s)), vec2(30.0 * s, 8.0 * s), 1.5 * s);
    strokeFill(col, dStep1, vec3(0.56, 0.27, 0.27), INK, 1.8 * s, 0.85 * s);
    strokeFill(col, dStep2, vec3(0.46, 0.22, 0.23), INK, 1.8 * s, 0.85 * s);
  }

  // 2 Trụ góc sau (Trái: Góc Đỏ; Phải: Góc Trắng/Bạc)
  float postHBack = 78.0 * s;
  float dPostBL = sdBox(p - (rg.bl + vec2(0.0, -postHBack * 0.5 + 4.0 * s)), vec2(6.5 * s, postHBack * 0.5), 2.0 * s);
  float dPostBR = sdBox(p - (rg.br + vec2(0.0, -postHBack * 0.5 + 4.0 * s)), vec2(6.5 * s, postHBack * 0.5), 2.0 * s);
  strokeFill(col, dPostBL, vec3(0.68, 0.24, 0.25), INK, 2.0 * s, 0.85 * s);
  strokeFill(col, dPostBR, vec3(0.82, 0.85, 0.90), INK, 2.0 * s, 0.85 * s);

  // 3 tầng dây thừng phía sau & hai bên hông (nửa trái Đỏ, nửa phải Xám than như bản gốc + rung đàn hồi!)
  for (int r = 0; r < 3; r++) {
    float hBack = (22.0 + float(r) * 21.0) * s;
    float hFront = (25.0 + float(r) * 24.0) * s;
    vec2 a = rg.bl + vec2(5.0 * s, -hBack);
    vec2 b = rg.br + vec2(-5.0 * s, -hBack);
    // Độ rung dây sau theo hàm sin giữa 2 trụ
    float uBack = clamp((p.x - a.x) / max(b.x - a.x, 1.0), 0.0, 1.0);
    float vib = sin(uBack * PI) * sin(uTime * 34.0 + float(r) * 1.4) * ropeVib * s;
    float dBackRope = abs(p.y - (a.y + vib)) - 2.8 * s;
    if (p.x >= a.x && p.x <= b.x && dBackRope < 2.5 * s) {
      vec3 rCol = (p.x < cx) ? vec3(0.76, 0.26, 0.28) : vec3(0.32, 0.33, 0.40);
      strokeFill(col, dBackRope, rCol, INK, 1.5 * s, 0.85 * s);
      // Đệm góc đài (Turnbuckles)
      float pad = min(abs(p.x - (a.x + 8.0 * s)), abs(p.x - (b.x - 8.0 * s))) - 6.0 * s;
      if (pad < 1.0 * s) {
        vec3 padC = (p.x < cx) ? vec3(0.92, 0.34, 0.34) : vec3(0.90, 0.92, 0.96);
        col = mix(col, padC, ss(1.0 * s, -0.5 * s, max(pad, dBackRope - 1.2 * s)));
      }
    }

    // Dây thừng bên hông trái (Đỏ) & bên hông phải (Trắng xám)
    vec2 flR = rg.fl + vec2(5.0 * s, -hFront);
    vec2 frR = rg.fr + vec2(-5.0 * s, -hFront);
    float dSideL = sdSeg(p, a, flR) - 3.0 * s;
    float dSideR = sdSeg(p, b, frR) - 3.0 * s;
    strokeFill(col, dSideL, vec3(0.80, 0.27, 0.28), INK, 1.6 * s, 0.85 * s);
    strokeFill(col, dSideR, vec3(0.74, 0.77, 0.84), INK, 1.6 * s, 0.85 * s);
  }
}

void drawRingFrontPostsAndRopes(inout vec3 col, vec2 p, RingGeom rg, float W, float s, float ropeVib) {
  float cx = W * 0.5;
  if (abs(p.x - cx) > 350.0 * s || p.y < rg.fl.y - 98.0 * s || p.y > rg.fl.y + 16.0 * s) return;

  // Dây thừng mặt trước vẽ mảnh & hơi bán trong suốt ở giữa để không bao giờ che khuất mặt và đòn đánh của 2 võ sĩ!
  for (int r = 0; r < 3; r++) {
    float hFront = (18.0 + float(r) * 20.0) * s;
    vec2 a = rg.fl + vec2(6.0 * s, -hFront);
    vec2 b = rg.fr + vec2(-6.0 * s, -hFront);
    float uFront = clamp((p.x - a.x) / max(b.x - a.x, 1.0), 0.0, 1.0);
    float vib = sin(uFront * PI) * sin(uTime * 32.0 + float(r) * 1.7 + 1.0) * ropeVib * 0.8 * s;
    float dRope = abs(p.y - (a.y + vib)) - 2.3 * s;
    if (p.x >= a.x && p.x <= b.x && dRope < 2.2 * s) {
      vec3 rCol = (p.x < cx) ? vec3(0.78, 0.26, 0.28) : vec3(0.36, 0.38, 0.46);
      // Giữa đài làm dịu alpha xuống 0.38 để thấy rõ chân và thân võ sĩ, hai đầu góc đài đậm nét 0.92
      float centerFade = mix(0.92, 0.36, ss(0.08, 0.28, uFront) * ss(0.92, 0.72, uFront));
      vec3 prev = col;
      strokeFill(col, dRope, rCol, INK, 1.4 * s, 0.85 * s);
      col = mix(prev, col, centerFade);
    }
  }

  // 2 Trụ góc trước (Trái: Đỏ; Phải: Trắng bạc)
  float postHFront = 84.0 * s;
  float dPostFL = sdBox(p - (rg.fl + vec2(0.0, -postHFront * 0.5 + 5.0 * s)), vec2(7.5 * s, postHFront * 0.5), 2.2 * s);
  float dPostFR = sdBox(p - (rg.fr + vec2(0.0, -postHFront * 0.5 + 5.0 * s)), vec2(7.5 * s, postHFront * 0.5), 2.2 * s);
  strokeFill(col, dPostFL, vec3(0.78, 0.27, 0.28), INK, 2.2 * s, 0.9 * s);
  strokeFill(col, dPostFR, vec3(0.88, 0.90, 0.95), INK, 2.2 * s, 0.9 * s);
}

// ---------------- 4. Võ sĩ Arcade kết hợp biến dạng đàn hồi Squash & Stretch (từ gymo-boxing) ----------------
vec2 deformHeadSpace(vec2 hp, vec4 headDef, vec4 faceWarp, float facing) {
  // Dịch chuyển & xoay theo lò xo cổ
  vec2 q = hp - headDef.xy;
  q = rot(-headDef.z) * q;

  // Squash & Stretch bảo toàn diện tích kiểu bánh mochi (w < 0: bẹp dọc phình ngang; w > 0: kéo giãn dọc)
  float sq = clamp(headDef.w, -0.58, 0.58);
  vec2 sc = vec2(exp(-sq * 0.54), exp(sq * 0.64));
  q /= sc;

  // Lõm/phình má cục bộ bất đối xứng quanh điểm trúng đòn
  vec2 push = faceWarp.zw;
  float pushMag = length(push);
  if (pushMag > 0.001) {
    vec2 dentP = faceWarp.xy;
    float falloff = exp(-length(q - dentP) / 36.0);
    q -= push * (0.65 * falloff + 0.20 * ss(48.0, -28.0, dot(q, normalize(push))));
  }
  q.x *= facing; // Chuẩn hóa hướng mặt nhìn sang phải (+X)
  return q;
}

void drawBoxer(
  inout vec3 col,
  vec2 p,
  int idx,
  float facing, // +1.0 cho Võ sĩ Trái (nhìn phải), -1.0 cho Võ sĩ Phải (nhìn trái)
  float s,
  float t
) {
  vec4 fPos = uFPos[idx];
  vec2 footBase = vec2(fPos.x + fPos.w * s, fPos.y);
  // Khung bao kiểm tra sớm để tiết kiệm GPU
  if (abs(p.x - footBase.x) > 135.0 * s || p.y < footBase.y - 185.0 * s || p.y > footBase.y + 28.0 * s) return;

  vec4 headDef = uFHead[idx];
  vec4 faceWarp = uFFace[idx];
  vec4 torsoDef = uFTorso[idx];
  vec4 expr = uFExpr[idx];

  // Quy về đơn vị chuẩn 900p tại tâm bàn chân
  vec2 lp = (p - footBase) / s;

  // 1. Bóng đổ hình elip dưới chân trên mặt sàn bạt xanh
  float dShadow = sdEllipse(lp - vec2(0.0, 4.0), vec2(34.0, 9.5));
  col = mix(col, vec3(0.06, 0.10, 0.22), ss(2.0, -2.0, dShadow) * 0.58);

  // Palette phân biệt Góc Đỏ (idx=0) vs Góc Xanh (idx=1)
  vec3 skin = (idx == 0) ? vec3(0.95, 0.76, 0.62) : vec3(0.89, 0.68, 0.54);
  vec3 skinShade = skin * 0.84;
  vec3 hairC = (idx == 0) ? vec3(0.32, 0.19, 0.14) : vec3(0.14, 0.13, 0.18);
  vec3 trunkC = vec3(0.15, 0.15, 0.20);
  vec3 trimC = (idx == 0) ? vec3(0.92, 0.24, 0.26) : vec3(0.22, 0.62, 0.96);
  vec3 gloveMain = (idx == 0) ? vec3(0.90, 0.20, 0.22) : vec3(0.86, 0.22, 0.26);

  float bob = fPos.z;
  // Khi đầu bị đấm bẹp (headDef.w < 0), đầu gối cũng nhún khuỵu xuống theo!
  float kneeCompress = min(0.0, headDef.w) * 18.0;
  float hipY = -42.0 + bob + kneeCompress * 0.45;

  // 2. Hai chân tấn thủ thế + tất trắng + giày Boxing cao cổ
  float stepSwing = sin(t * 6.5 + float(idx) * 2.1) * 3.2;
  vec2 ankleBack = vec2(-facing * (16.0 - stepSwing * 0.4), 0.0);
  vec2 ankleFront = vec2(facing * (18.0 + stepSwing * 0.4), 2.0);
  vec2 hipBack = vec2(-facing * 10.0, hipY);
  vec2 hipFront = vec2(facing * 10.0, hipY);

  // Cẳng chân sau & trước
  for (int leg = 0; leg < 2; leg++) {
    vec2 ak = (leg == 0) ? ankleBack : ankleFront;
    vec2 hp = (leg == 0) ? hipBack : hipFront;
    vec2 knee = 0.5 * (ak + hp) + vec2(facing * (leg == 0 ? -3.0 : 5.5), -2.0);
    float dThigh = sdSeg(lp, hp, knee) - 6.8;
    float dCalf = sdSeg(lp, knee, ak + vec2(0.0, -8.0)) - 5.8;
    strokeFill(col, min(dThigh, dCalf), (leg == 0) ? skinShade : skin, INK, 2.4, 0.9);

    // Tất trắng + Giày đấm bốc cổ cao
    float dSock = sdBox(lp - (ak + vec2(0.0, -9.5)), vec2(6.2, 4.8), 2.0);
    strokeFill(col, dSock, vec3(0.95, 0.96, 0.99), INK, 2.2, 0.9);
    float dBoot = sdBox(lp - (ak + vec2(facing * 3.5, -3.2)), vec2(10.5, 4.8), 3.2);
    strokeFill(col, dBoot, (leg == 0) ? vec3(0.16, 0.16, 0.21) : trimC * 0.85, INK, 2.3, 0.9);
  }

  // 3. Thân trên (Quần đùi Boxing đai trắng + Cơ ngực bụng biến dạng Squash/Shear & cong chữ C khi dính đòn bụng!)
  vec2 torsoCenter = vec2(0.0, hipY - 24.0 + kneeCompress * 0.35);
  vec2 tp = lp - torsoCenter;
  // Nghiêng shear + nén giãn thân + lõm cong chữ C (bodyDent)
  tp.x -= tp.y * torsoDef.x * 0.38;
  float tSq = clamp(torsoDef.y, -0.45, 0.45);
  tp /= vec2(exp(-tSq * 0.45), exp(tSq * 0.55));
  // Khi ăn đòn bụng (torsoDef.z > 0), phần giữa bụng uốn lùi ra sau chữ C!
  float cBend = torsoDef.z * sin(clamp((tp.y + 24.0) / 48.0, 0.0, 1.0) * PI);
  tp.x += facing * cBend * 14.0;

  // Quần đùi Boxing đen + đai lưng trắng sọc màu góc đài
  float dShorts = sdBox(tp - vec2(0.0, 21.0), vec2(21.0, 12.5), 4.5);
  if (dShorts < 3.5) {
    vec3 shC = trunkC;
    // Sọc dọc bên hông quần
    float sideStripe = ss(3.5, 1.5, abs(tp.x - facing * 12.0));
    shC = mix(shC, trimC, sideStripe * 0.9);
    strokeFill(col, dShorts, shC, INK, 2.5, 0.9);
    // Đai trắng bảng tên vô địch
    float dBelt = sdBox(tp - vec2(0.0, 11.5), vec2(21.2, 4.2), 1.5);
    strokeFill(col, dBelt, vec3(0.95, 0.96, 0.99), INK, 2.0, 0.9);
  }

  // Thân ngực trần vạm vỡ vừa vặn
  float dChest = sdBox(tp - vec2(0.0, -6.0), vec2(21.5, 18.5), 9.0);
  if (dChest < 3.5) {
    vec3 bodyC = mix(skin, skinShade, ss(-12.0, 16.0, -facing * tp.x));
    // Nét cơ ngực & bụng nhẹ kiểu pixel-arcade
    float pecLine = ss(1.4, 0.3, abs(tp.y + 5.0)) * ss(14.0, 4.0, abs(tp.x));
    bodyC = mix(bodyC, skinShade * 0.88, pecLine * 0.65);
    strokeFill(col, dChest, bodyC, INK, 2.5, 0.9);
  }

  // Cánh tay sau (vươn thẳng ra đấm nếu punchExt > 0!)
  float punchExt = torsoDef.w;
  vec2 shoulBack = torsoCenter + vec2(facing * 12.0, -16.0);
  vec2 gloveBackPos = shoulBack + vec2(facing * (22.0 + punchExt * 48.0), 4.0 - punchExt * 10.0);
  float dArmBack = sdSeg(lp, shoulBack, gloveBackPos) - 5.8;
  strokeFill(col, dArmBack, skinShade, INK, 2.2, 0.9);
  // Bầu găng tay sau
  float dGBack = sdBox(lp - gloveBackPos, vec2(12.5 + punchExt * 3.5, 10.5), 7.5);
  strokeFill(col, dGBack, gloveMain * 0.88, INK, 2.4, 0.9);

  // 4. Đầu Võ Sĩ (Tỷ lệ Chibi-Arcade 1.35x rõ biểu cảm, biến dạng đàn hồi Squash & Stretch như bánh mochi!)
  vec2 neckBase = torsoCenter + vec2(-torsoDef.x * 8.0, -49.0 + kneeCompress * 0.55);
  vec2 q = deformHeadSpace(lp - neckBase, headDef, faceWarp, facing);

  if (length(q) < 62.0) {
    // Tóc sau gáy & tai bên (vẽ trước khuôn mặt để không bao giờ che lên mắt)
    float dHairBack = sdEllipse(q - vec2(-8.5, -7.5), vec2(19.5, 19.0));
    strokeFill(col, dHairBack, hairC, INK, 2.4, 0.9);
    float dEar = sdEllipse(q - vec2(-20.5, 2.5), vec2(6.5, 8.0));
    strokeFill(col, dEar, skinShade, INK, 2.3, 0.9);

    // Khuôn mặt bầu bĩnh khỏe khoắn
    float dFace = sdBox(q, vec2(23.5, 22.0), 17.0);
    float dCheek = sdEllipse(q - vec2(4.0, 6.5), vec2(22.5, 15.0));
    dFace = smin(dFace, dCheek, 5.0);
    if (dFace < 3.5) {
      vec3 fCol = mix(skin, skinShade, ss(12.0, -18.0, q.x));
      // Má ửng đỏ hồng khi ăn đòn hoặc hăng máu
      float blush = ss(9.5, 2.0, length(q - vec2(9.0, 7.5)));
      fCol = mix(fCol, vec3(0.98, 0.45, 0.46), blush * (0.28 + 0.42 * expr.y));
      strokeFill(col, dFace, fCol, INK, 2.6, 0.9);
    }

    // Phần tóc đỉnh đầu + mai tóc bên thái dương (nằm gọn phía trên băng đô trán)
    float dHairTop = sdBox(q - vec2(1.0, -20.2), vec2(24.0, 8.2), 6.2);
    float dSideburn = sdBox(q - vec2(-18.5, -8.2), vec2(4.6, 7.8), 2.5);
    dHairTop = smin(dHairTop, dSideburn, 2.5);
    if (idx == 0) {
      // Võ sĩ Trái: tóc nâu dựng năng động + băng đô đỏ
      float spike1 = sdEllipse(rot(-0.35) * (q - vec2(15.0, -23.0)), vec2(9.2, 5.0));
      float spike2 = sdEllipse(rot(-0.15) * (q - vec2(4.0, -25.5)), vec2(9.2, 5.2));
      dHairTop = smin(dHairTop, min(spike1, spike2), 3.5);
    } else {
      // Võ sĩ Phải: tóc đen gọn thể thao + băng đô xanh
      float wave = sdEllipse(rot(0.22) * (q - vec2(12.0, -22.0)), vec2(11.2, 5.5));
      dHairTop = smin(dHairTop, wave, 3.5);
    }
    strokeFill(col, dHairTop, hairC, INK, 2.4, 0.9);

    // Băng đô trán cùng màu góc đài
    float dBand = sdBox(q - vec2(1.2, -13.2), vec2(24.0, 3.6), 1.5);
    dBand = max(dBand, dFace - 1.0);
    strokeFill(col, dBand, trimC, INK, 1.8, 0.9);

    // Biểu cảm Mắt & Lông mày & Miệng (kế thừa trọn vẹn biểu cảm của gymo-boxing!)
    vec2 eyeL = vec2(2.0, -2.5);
    vec2 eyeR = vec2(15.5, -2.5);
    if (expr.z > 0.25) {
      // Choáng váng (@ @ xoắn ốc quay tròn khi dính Combo >= 4!)
      for (int e = 0; e < 2; e++) {
        vec2 ep = q - (e == 0 ? eyeL : eyeR);
        float r = length(ep);
        if (r < 6.8) {
          float ang = atan(ep.y, ep.x) + t * 14.0 * (e == 0 ? 1.0 : -1.0);
          float spiral = sin(r * 1.45 - ang * 1.0);
          col = mix(col, INK, ss(0.25, 0.65, spiral) * ss(6.5, 5.0, r));
        }
      }
    } else if (expr.y > 0.20) {
      // Nhắm tít mắt "> <" khi vừa ăn đấm!
      float dW1 = min(sdSeg(q, eyeL + vec2(-4.2, -3.2), eyeL + vec2(2.2, 0.0)), sdSeg(q, eyeL + vec2(-4.2, 3.2), eyeL + vec2(2.2, 0.0))) - 1.6;
      float dW2 = min(sdSeg(q, eyeR + vec2(4.2, -3.2), eyeR + vec2(-2.2, 0.0)), sdSeg(q, eyeR + vec2(4.2, 3.2), eyeR + vec2(-2.2, 0.0))) - 1.6;
      col = mix(col, INK, ss(0.7, -0.3, min(dW1, dW2)));
    } else {
      // Mắt chiến đấu quyết tâm + chớp mắt tự nhiên + lông mày xếch
      float openH = max(0.6, 4.2 * (1.0 - expr.x));
      float dE1 = sdBox(q - eyeL, vec2(2.6, openH), 1.8);
      float dE2 = sdBox(q - eyeR, vec2(2.6, openH), 1.8);
      col = mix(col, INK, ss(0.7, -0.3, min(dE1, dE2)));
      if (openH > 2.2) {
        float spec = min(length(q - (eyeL + vec2(0.8, -1.2))), length(q - (eyeR + vec2(0.8, -1.2)))) - 1.1;
        col = mix(col, vec3(1.0), ss(0.6, -0.2, spec));
      }
      // Lông mày tập trung
      float dB1 = sdSeg(q, eyeL + vec2(-3.8, -6.2), eyeL + vec2(3.2, -4.6)) - 1.5;
      float dB2 = sdSeg(q, eyeR + vec2(-2.5, -4.6), eyeR + vec2(3.8, -6.2)) - 1.5;
      col = mix(col, hairC * 0.7, ss(0.7, -0.3, min(dB1, dB2)));
    }

    // Miệng: nhe răng gồng / há tròn "O" khi ăn đòn / nhếch môi tự tin khi bình thường
    if (expr.y > 0.22 || expr.z > 0.25) {
      float dMouth = sdBox(q - vec2(9.5, 10.5), vec2(5.5, 4.0), 3.0);
      strokeFill(col, dMouth, vec3(0.78, 0.24, 0.30), INK, 1.5, 0.8);
      float dTeeth = sdBox(q - vec2(9.5, 8.2), vec2(4.2, 1.5), 0.8);
      col = mix(col, vec3(0.98), ss(0.6, -0.3, max(dTeeth, dMouth)));
    } else {
      float dSmile = sdSeg(q, vec2(5.5, 10.2), vec2(13.5, 9.2)) - 1.4;
      col = mix(col, INK, ss(0.7, -0.3, dSmile));
    }
  }

  // 5. Cánh tay trước + Găng tay thủ thế trước cằm (hạ bung rộng khi bị choáng hoặc ăn đấm!)
  float guardDrop = expr.z * 12.0 + expr.y * 5.0;
  vec2 shoulFront = torsoCenter + vec2(-facing * 12.0, -14.0);
  vec2 elbowFront = torsoCenter + vec2(-facing * 6.0, 2.0 + guardDrop * 0.4);
  vec2 gloveFrontPos = torsoCenter + vec2(facing * (14.0 - guardDrop * 0.6), -20.0 + guardDrop);
  float dUpperArm = sdSeg(lp, shoulFront, elbowFront) - 6.2;
  float dForeArm = sdSeg(lp, elbowFront, gloveFrontPos) - 5.8;
  strokeFill(col, min(dUpperArm, dForeArm), skin, INK, 2.3, 0.9);

  // Cổ băng trắng + Bầu găng đỏ bóng phía trước
  vec2 gfp = lp - gloveFrontPos;
  float dCuff = sdBox(gfp - vec2(-facing * 8.5, 4.0), vec2(5.0, 6.8), 2.5);
  strokeFill(col, dCuff, vec3(0.96, 0.97, 1.0), INK, 2.0, 0.9);
  float dGloveF = sdBox(gfp, vec2(12.8, 11.2), 8.0);
  if (dGloveF < 3.5) {
    vec3 gCol = mix(gloveMain, gloveMain * 0.68, ss(-6.0, 10.0, gfp.y));
    float gSpec = ss(5.5, 1.0, length(gfp - vec2(facing * 2.5, -4.0)));
    gCol = mix(gCol, vec3(1.0, 0.74, 0.72), gSpec * 0.65);
    strokeFill(col, dGloveF, gCol, INK, 2.5, 0.9);
  }

  // 6. Chớp sáng trắng-hồng chớp nhoáng ngay khoảnh khắc dính đòn (Hit-Flash Arcade)
  if (expr.w > 0.01) {
    float bodyApprox = length((lp - vec2(0.0, -52.0)) * vec2(0.85, 0.52)) - 42.0;
    col = mix(col, vec3(1.0, 0.92, 0.88), ss(8.0, -8.0, bodyApprox) * expr.w * 0.42);
  }

  // 7. Vòng 3 ngôi sao vàng 5 cánh bay quay tròn trên đầu khi bị Choáng (Combo >= 4)!
  if (expr.z > 0.05) {
    float dAlpha = clamp(expr.z * 1.4, 0.0, 1.0);
    vec2 crown = neckBase + headDef.xy + vec2(0.0, -34.0);
    for (int st = 0; st < 3; st++) {
      float a = t * 5.2 + float(st) * (2.0 * PI / 3.0);
      vec2 sp = lp - (crown + vec2(cos(a) * 26.0, sin(a) * 6.5));
      // Quỹ đạo elip mờ
      float dStar = sdStar5(rot(t * 3.0 + float(st)) * sp, 7.2, 0.45);
      if (dStar < 2.5) {
        vec3 stCol = vec3(1.0, 0.84, 0.22);
        vec3 prev = col;
        strokeFill(col, dStar, stCol, INK, 1.8, 0.85);
        col = mix(prev, col, dAlpha);
      }
    }
  }
}

// ---------------- 5. Khói tròn Puff, Giọt mồ hôi & Găng tay Boxing phóng vào khi Click (từ gymo-boxing) ----------------
void drawPuffBurst(inout vec3 col, vec2 p, vec4 puff, float s) {
  if (puff.w <= 0.01 || puff.z >= 1.0) return;
  float age = puff.z;
  vec2 c = puff.xy;
  if (length(p - c) > 125.0 * s) return;

  float alpha = (1.0 - age) * (1.0 - age);
  // 5 cụm mây khói tròn trắng mờ bung tỏa + tia sao va chạm giữa tâm
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    float ang = puff.w * 6.283 + fk * 1.2566;
    float dist = (10.0 + 54.0 * pow(age, 0.62)) * (0.75 + 0.4 * hash1(fk + puff.w * 13.0)) * s;
    vec2 pc = c + vec2(cos(ang), sin(ang) * 0.78 - age * 14.0) * dist;
    float rad = (13.5 - 6.5 * age) * (0.8 + 0.35 * hash1(fk * 3.1)) * s;
    float d = length(p - pc) - rad;
    if (d < 2.5 * s) {
      float aFill = ss(1.0 * s, -1.0 * s, d) * alpha * 0.86;
      float aRim = ss(2.2 * s, 0.4 * s, abs(d)) * alpha * 0.55;
      col = mix(col, vec3(0.96, 0.97, 1.0), aFill);
      col = mix(col, INK, aRim);
    }
  }

  // Giọt mồ hôi xanh sáng bắn văng hình vòng cung khi vừa chạm đòn
  if (age < 0.75) {
    for (int sw = -1; sw <= 1; sw += 2) {
      vec2 sp = c + vec2(float(sw) * (16.0 + 62.0 * age) * s, (-24.0 * age + 58.0 * age * age) * s);
      float dDrop = sdEllipse(rot(float(sw) * 0.5) * (p - sp), vec2(2.6 * s, 5.2 * s));
      col = mix(col, vec3(0.68, 0.92, 1.0), ss(0.8 * s, -0.4 * s, dDrop) * (1.0 - age / 0.75));
    }
  }

  // Tia chớp sao vàng cam lóe lên trong 0.22s đầu tại tâm cú đấm
  if (age < 0.25) {
    float flashA = 1.0 - age / 0.25;
    float dSpark = sdStar5((p - c) / max(s * (0.8 + age * 2.2), 1e-3), 18.0, 0.36) * s;
    if (dSpark < 2.5 * s) {
      vec3 prev = col;
      strokeFill(col, dSpark, vec3(1.0, 0.76, 0.20), vec3(1.0, 0.36, 0.18), 2.0 * s, 0.9 * s);
      col = mix(prev, col, flashA * 0.92);
    }
  }
}

void drawPunchGlove(inout vec3 col, vec2 p, vec4 g, vec4 meta, float style, float s) {
  if (g.w <= 0.005) return;
  vec2 gp = g.xy;
  float sc = clamp(g.w, 0.25, 1.45) * 0.86;
  if (length(p - gp) > 150.0 * s * sc) return;

  float alpha = clamp(g.w, 0.0, 1.0);
  vec2 q = rot(-g.z) * (p - gp) / (s * sc);

  // Vệt gió xé không khí phía sau găng khi đang lao vút tới (phase < 1.05)
  if (meta.z < 1.05) {
    for (int w = -1; w <= 1; w += 2) {
      float wy = float(w) * 24.0;
      float dWind = sdSeg(q, vec2(-98.0, wy), vec2(-38.0, wy)) - 2.0;
      col = mix(col, vec3(0.95, 0.97, 1.0), ss(1.1, -0.3, dWind) * 0.62 * alpha);
    }
  }

  vec3 layer = col;
  if (style > 0.5 && style < 1.5) {
    // Kiểu 1: Siêu Nắm Đấm Hoạt Hình Phóng Đại (kế thừa từ gymo-boxing)
    float dSleeve = sdBox(q - vec2(-64.0, 0.0), vec2(32.0, 20.0), 7.0);
    strokeFill(layer, dSleeve, vec3(0.38, 0.34, 0.76), INK, 2.8, 0.95);
    float dPalm = sdBox(q - vec2(-8.0, 0.0), vec2(28.0, 31.0), 14.0);
    float dFist = dPalm;
    for (int f = 0; f < 4; f++) {
      float fy = -22.0 + float(f) * 14.8;
      dFist = smin(dFist, sdEllipse(q - vec2(16.0 - abs(float(f) - 1.5) * 2.2, fy), vec2(14.5, 9.5)), 4.5);
    }
    dFist = smin(dFist, sdBox(rot(-0.25) * (q - vec2(-2.0, 29.0)), vec2(16.5, 9.8), 8.0), 5.0);
    strokeFill(layer, dFist, vec3(0.98, 0.80, 0.66), INK, 2.8, 0.95);
  } else if (style > 1.5) {
    // Kiểu 2: Găng Chân Mèo Đệm Thịt Hồng vui nhộn
    float dCuff = sdBox(q - vec2(-44.0, 0.0), vec2(17.0, 25.0), 8.0);
    strokeFill(layer, dCuff, vec3(0.98, 0.56, 0.68), INK, 2.8, 0.95);
    float dPaw = sdEllipse(q - vec2(-4.0, 0.0), vec2(36.0, 34.0));
    for (int tIdx = -1; tIdx <= 1; tIdx++) {
      dPaw = smin(dPaw, length(q - vec2(21.0 - abs(float(tIdx)) * 4.0, float(tIdx) * 18.0)) - 14.5, 7.0);
    }
    strokeFill(layer, dPaw, vec3(0.99, 0.97, 0.96), INK, 2.8, 0.95);
    vec3 beanC = vec3(0.98, 0.58, 0.68);
    layer = mix(layer, beanC, ss(0.9, -0.5, sdEllipse(q - vec2(-4.0, 0.0), vec2(13.5, 16.5))));
    for (int bIdx = -1; bIdx <= 1; bIdx++) {
      layer = mix(layer, beanC, ss(0.9, -0.5, length(q - vec2(17.5 - abs(float(bIdx)) * 3.0, float(bIdx) * 16.0)) - 6.2));
    }
  } else {
    // Kiểu 0 (Mặc định): Găng Boxing Đỏ Vô Địch bóng bẩy
    float dCuff = sdBox(q - vec2(-45.0, -1.0), vec2(17.5, 26.5), 8.0);
    if (dCuff < 4.5) {
      vec3 cuffC = mix(vec3(0.97, 0.98, 1.0), vec3(0.98, 0.76, 0.18), ss(4.8, 2.0, abs(q.x + 45.0)));
      strokeFill(layer, dCuff, cuffC, INK, 2.8, 0.95);
    }
    float dMain = sdBox(q - vec2(0.0, -2.0), vec2(39.0, 34.0), 24.5);
    float dThumb = sdBox(rot(-0.28) * (q - vec2(-5.0, 28.0)), vec2(23.0, 14.0), 11.5);
    float dGlove = smin(dMain, dThumb, 6.2);
    if (dGlove < 4.5) {
      vec3 gCol = mix(vec3(0.92, 0.18, 0.21), vec3(0.64, 0.09, 0.13), ss(-10.0, 32.0, q.y));
      float spec = ss(17.0, 2.0, length((q - vec2(9.5, -14.0)) * vec2(0.68, 1.28)));
      gCol = mix(gCol, vec3(1.0, 0.72, 0.70), spec * 0.72);
      strokeFill(layer, dGlove, gCol, INK, 2.9, 0.95);
    }
  }
  col = mix(col, layer, alpha);
}

// ---------------- 6. Thanh Máu & Đồng Hồ Hiệp Đấu Arcade (HUD) ----------------
// Vẽ chữ số 7 thanh sắc nét kiểu máy thùng Arcade cho đồng hồ "60" và số hiệp
float sdDigit7(vec2 p, int d, float sc) {
  p /= sc;
  if (abs(p.x) > 5.5 || abs(p.y) > 9.0) return 10.0;
  // Các thanh: 0=top, 1=topL, 2=topR, 3=mid, 4=botL, 5=botR, 6=bot
  int mask = 0;
  if (d == 0) mask = 119;
  else if (d == 1) mask = 36;
  else if (d == 2) mask = 93;
  else if (d == 3) mask = 109;
  else if (d == 4) mask = 46;
  else if (d == 5) mask = 107;
  else if (d == 6) mask = 123;
  else if (d == 7) mask = 37;
  else if (d == 8) mask = 127;
  else mask = 111;

  float dist = 99.0;
  if ((mask & 1) != 0) dist = min(dist, sdBox(p - vec2(0.0, -6.5), vec2(3.4, 1.0), 0.4));
  if ((mask & 2) != 0) dist = min(dist, sdBox(p - vec2(-3.2, -3.3), vec2(1.0, 3.0), 0.4));
  if ((mask & 4) != 0) dist = min(dist, sdBox(p - vec2(3.2, -3.3), vec2(1.0, 3.0), 0.4));
  if ((mask & 8) != 0) dist = min(dist, sdBox(p, vec2(3.2, 1.0), 0.4));
  if ((mask & 16) != 0) dist = min(dist, sdBox(p - vec2(-3.2, 3.3), vec2(1.0, 3.0), 0.4));
  if ((mask & 32) != 0) dist = min(dist, sdBox(p - vec2(3.2, 3.3), vec2(1.0, 3.0), 0.4));
  if ((mask & 64) != 0) dist = min(dist, sdBox(p - vec2(0.0, 6.5), vec2(3.4, 1.0), 0.4));
  return dist * sc;
}

void drawArcadeHud(inout vec3 col, vec2 p, float W, float s, float hudMode) {
  if (hudMode > 1.5) return; // Ẩn hoàn toàn khi chọn chế độ Ẩn
  float compact = (hudMode > 0.5) ? 0.78 : 1.0;
  float hs = s * compact;
  float topY = 34.0 * hs;
  if (p.y > topY + 52.0 * hs) return;

  float cx = W * 0.5;
  float totalHalf = 365.0 * hs;
  if (abs(p.x - cx) > totalHalf + 18.0 * hs) return;

  // 1. Hộp đồng hồ trung tâm ("60" + khung ROUND 1-12 y hệt bố cục pin gốc!)
  vec2 timerC = vec2(cx, topY);
  float dTimerBox = sdBox(p - timerC, vec2(44.0 * hs, 20.0 * hs), 3.0 * hs);
  if (dTimerBox < 3.0 * hs) {
    vec3 boxC = mix(vec3(0.18, 0.16, 0.19), vec3(0.28, 0.25, 0.28), uRound.z);
    strokeFill(col, dTimerBox, boxC, vec3(0.84, 0.85, 0.90), 2.0 * hs, 0.85 * hs);
    int secs = clamp(int(floor(uRound.y + 0.5)), 0, 99);
    float dTen = sdDigit7(p - (timerC + vec2(-10.5 * hs, 0.0)), secs / 10, 1.45 * hs);
    float dOne = sdDigit7(p - (timerC + vec2(10.5 * hs, 0.0)), secs - (secs / 10) * 10, 1.45 * hs);
    col = mix(col, vec3(0.96, 0.96, 0.98), ss(0.7 * hs, -0.3 * hs, min(dTen, dOne)));
  }

  // Nhãn "ROUND" nhỏ phía dưới đồng hồ
  vec2 rndC = vec2(cx, topY + 29.0 * hs);
  float dRndBox = sdBox(p - rndC, vec2(48.0 * hs, 8.5 * hs), 2.0 * hs);
  if (dRndBox < 2.5 * hs) {
    strokeFill(col, dRndBox, vec3(0.15, 0.14, 0.17), vec3(0.76, 0.78, 0.84), 1.5 * hs, 0.8 * hs);
    // Vạch chấm biểu thị số hiệp hiện tại (1..12) + chữ số hiệp bên phải
    int rnd = clamp(int(floor(uRound.x + 0.5)), 1, 12);
    for (int b = 0; b < 5; b++) {
      float bx = rndC.x - 32.0 * hs + float(b) * 8.0 * hs;
      float dPip = sdBox(p - vec2(bx, rndC.y), vec2(2.4 * hs, 3.2 * hs), 0.6 * hs);
      vec3 pipC = (b < ((rnd - 1) % 5) + 1) ? vec3(0.96, 0.76, 0.24) : vec3(0.35, 0.36, 0.42);
      col = mix(col, pipC, ss(0.6 * hs, -0.3 * hs, dPip));
    }
    float dR1 = sdDigit7(p - (rndC + vec2(18.0 * hs, 0.0)), rnd / 10, 0.62 * hs);
    float dR2 = sdDigit7(p - (rndC + vec2(28.0 * hs, 0.0)), rnd - (rnd / 10) * 10, 0.62 * hs);
    col = mix(col, vec3(0.94, 0.95, 0.98), ss(0.6 * hs, -0.3 * hs, (rnd >= 10) ? min(dR1, dR2) : dR2));
  }

  // 2. Hai khung chân dung + Thanh máu xanh lá hai bên (P1 Trái & P2 Phải)
  for (int side = 0; side < 2; side++) {
    float sgn = (side == 0) ? -1.0 : 1.0;
    float hp = (side == 0) ? uHud.x : uHud.z;
    float hpLag = (side == 0) ? uHud.y : uHud.w;

    // Ô chân dung góc ngoài (Trái màu Đỏ rượu, Phải màu Xanh chàm như pin gốc!)
    vec2 portC = vec2(cx + sgn * 336.0 * hs, topY + 2.0 * hs);
    float dPort = sdBox(p - portC, vec2(23.0 * hs, 23.0 * hs), 2.5 * hs);
    if (dPort < 2.8 * hs) {
      vec3 pBg = (side == 0) ? vec3(0.45, 0.19, 0.20) : vec3(0.18, 0.20, 0.34);
      strokeFill(col, dPort, pBg, vec3(0.84, 0.85, 0.90), 1.8 * hs, 0.85 * hs);
      // Silhouette đầu võ sĩ mini trong khung avatar
      float dMiniHead = length(p - (portC + vec2(0.0, 2.0 * hs))) - 9.5 * hs;
      vec3 skinM = (side == 0) ? vec3(0.94, 0.75, 0.60) : vec3(0.88, 0.67, 0.53);
      col = mix(col, skinM, ss(0.8 * hs, -0.4 * hs, dMiniHead));
      float dMiniBand = sdBox(p - (portC + vec2(0.0, -3.5 * hs)), vec2(9.8 * hs, 2.2 * hs), 0.8 * hs);
      col = mix(col, (side == 0) ? vec3(0.92, 0.25, 0.26) : vec3(0.24, 0.64, 0.96), ss(0.7 * hs, -0.3 * hs, max(dMiniBand, dMiniHead)));
    }

    // Thanh máu dài nối từ khung chân dung vào hộp đồng hồ trung tâm
    float barInX = cx + sgn * 54.0 * hs;
    float barOutX = cx + sgn * 306.0 * hs;
    float barCx = 0.5 * (barInX + barOutX);
    float barHw = 0.5 * abs(barOutX - barInX);
    vec2 barP = p - vec2(barCx, topY - 4.0 * hs);
    float dBarFrame = sdBox(barP, vec2(barHw, 10.5 * hs), 2.0 * hs);
    if (dBarFrame < 2.8 * hs) {
      strokeFill(col, dBarFrame, vec3(0.14, 0.13, 0.16), vec3(0.86, 0.87, 0.92), 1.8 * hs, 0.85 * hs);
      // Tính tỉ lệ lấp đầy tính từ phía trung tâm (hoặc phía ngoài): rút máu từ trong ra ngoài góc chân dung
      float innerHw = barHw - 3.0 * hs;
      float u = (side == 0)
        ? clamp((barP.x + innerHw) / max(2.0 * innerHw, 1.0), 0.0, 1.0)
        : clamp((innerHw - barP.x) / max(2.0 * innerHw, 1.0), 0.0, 1.0);
      float dIn = sdBox(barP, vec2(innerHw, 7.2 * hs), 1.0 * hs);
      if (dIn < 0.8 * hs) {
        vec3 fillC = vec3(0.24, 0.14, 0.16);
        if (u <= hpLag) fillC = vec3(0.96, 0.78, 0.20); // Vạch vàng tụt trễ kiểu Street Fighter
        if (u <= hp) {
          vec3 grn = mix(vec3(0.26, 0.58, 0.22), vec3(0.45, 0.76, 0.30), ss(7.0 * hs, -7.0 * hs, barP.y));
          if (hp < 0.28) grn = mix(vec3(0.85, 0.24, 0.22), vec3(0.98, 0.52, 0.20), 0.5 + 0.5 * sin(uTime * 14.0));
          fillC = grn;
        }
        col = mix(col, fillC, ss(0.7 * hs, -0.5 * hs, dIn));
      }
    }
  }
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y * uScale - gl_FragCoord.y) / uScale;
  float W = uRes.x, H = uRes.y;
  float availH = max(280.0, H - 48.0);
  float s = min(W / 1080.0, availH / 640.0);
  float floorY = availH * 0.555;

  float iconS = mix(fieldS(uFA, p), fieldS(uFB, p), uMix);

  // 1. Nền phòng tập quyền anh, cửa sổ kính teal & thảm cao su ôm biểu tượng Desktop
  vec3 col = drawGymRoom(p, W, H, floorY, s, iconS);

  // 2. Đạo cụ phía sau phòng tập (kệ tạ, ghế băng, dây nhảy, 3 bao cát treo đung đưa)
  drawGymPropsBack(col, p, W, availH, floorY, s);

  // 3. Võ đài quyền anh nâng cao góc nhìn 3/4 + dây thừng sau & hông
  RingGeom rg = makeRing(W, availH, s, uScene.z * s);
  drawRingBaseAndBackRopes(col, p, rg, W, s, uScene.w);

  // 4. Hai võ sĩ trên sàn đài (vẽ theo thứ tự chiều sâu y để người đứng trước đè lên người đứng sau tự nhiên)
  if (uFPos[0].y <= uFPos[1].y) {
    drawBoxer(col, p, 0, 1.0, s, uTime);
    drawBoxer(col, p, 1, -1.0, s, uTime);
  } else {
    drawBoxer(col, p, 1, -1.0, s, uTime);
    drawBoxer(col, p, 0, 1.0, s, uTime);
  }

  // 5. Trụ góc trước & dây thừng mặt trước (làm dịu alpha ở giữa để không che võ sĩ)
  drawRingFrontPostsAndRopes(col, p, rg, W, s, uScene.w);

  // 6. Đạo cụ tiền cảnh hai góc dưới (lốp xe tải + búa tạ, tạ chuông, bóng tạ đỏ)
  drawGymPropsFront(col, p, W, availH, s);

  // 7. Cụm khói tròn Puff, mồ hôi bắn & sao lóe va chạm
  for (int i = 0; i < 6; i++) {
    drawPuffBurst(col, p, uPuffs[i], s);
  }

  // 8. Các găng tay Boxing phóng vào đấm khi Click hoặc đôi công liên hoàn
  for (int g = 0; g < 4; g++) {
    drawPunchGlove(col, p, uGloves[g], uGloveMeta[g], uScene.x, s);
  }

  // 9. Thanh máu & Bảng đồng hồ hiệp đấu Arcade phía trên
  drawArcadeHud(col, p, W, s, uScene.y);

  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}
