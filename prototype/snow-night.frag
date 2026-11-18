#version 300 es
// Deskland · Đêm tuyết ngắm phố (Snowy Overlook)
// Dùng chung cho cả prototype/snow-night.html (WebGL2) và deskland-rs (OpenGL 3.3).
// Đêm tuyết rơi trên đỉnh đồi nhìn xuống thành phố lên đèn: dãy nhà cao tầng sáng cửa sổ,
// đèn hàng không đỏ nhấp nháy, dòng xe chảy trên cao tốc, đồi tối lấm tấm đèn nhà,
// rặng thông phủ tuyết hai bên và một phi hành gia ngồi trên nóc chiếc xe đỏ kéo violin giữa đồi tuyết.
// Tuyết rơi 3 lớp xa gần; quãng rơi/quãng trôi theo gió được cộng dồn bên CPU nên đổi gió không giật.

precision highp float;

uniform sampler2D uNoise, uFA, uFB;
uniform vec2 uRes, uGrid;
uniform float uScale, uSeed, uStep, uMix, uTime, uDebug;

uniform vec4 uScene;     // x=lượng tuyết (0..1), y=đèn thành phố (0..1), z=hiện phi hành gia & xe (0/1), w=0
uniform vec4 uSnow;      // x=quãng rơi (giây), y=quãng trôi theo gió (px ở s=1), z=gió hiện tại (-1..1), w=độ rung cây
uniform vec4 uKid;       // phi hành gia: x=vị trí vĩ (-1..1), y=đung đưa (-1..1), z=độ hăng say (0..1), w=pha nốt nhạc
uniform vec4 uBursts[4]; // x,y điểm nổ; z=tuổi (giây, <-50 = không có); w=màu pháo hoa (0..1) hoặc -1 = bụi tuyết rụng

out vec4 o;

const float PI = 3.14159265;

// ---------------- Hàm cơ sở ----------------
float hash1(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
float hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float ss(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float cover(float d, float aa) { return clamp(0.5 - d / aa, 0.0, 1.0); }
float fieldS(sampler2D t, vec2 p) { return texture(t, (p / uStep + 0.5) / uGrid).r; }
float iconField(vec2 p) { return mix(fieldS(uFA, p), fieldS(uFB, p), uMix); }
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0));
}
float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
vec3 hue(float h) {
  vec3 c = clamp(abs(fract(h + vec3(0.0, 2.0, 1.0) / 3.0) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), c, 0.75);
}

// Bảng màu chung
const vec3 SNOW_LIT = vec3(0.93, 0.95, 1.00);
const vec3 SNOW_SHADE = vec3(0.36, 0.43, 0.60);
const vec3 SNOW_DEEP = vec3(0.18, 0.22, 0.34);
const vec3 WARM = vec3(1.00, 0.80, 0.52);

// ---------------- 1. Bầu trời ----------------
vec3 sky(vec2 p, float W, float hz, float s, float lights) {
  float ny = clamp(p.y / hz, 0.0, 1.2);
  vec3 col = mix(vec3(0.030, 0.040, 0.075), vec3(0.12, 0.13, 0.19), ss(0.0, 1.0, ny));
  // Quầng sáng thành phố hắt lên mây
  float gx = (p.x - 0.5 * W) / (0.36 * W);
  col += vec3(0.34, 0.21, 0.16) * exp(-gx * gx) * ss(0.25, 1.05, ny) * (0.18 + 0.30 * lights);
  // Mây tuyết thấp mờ trôi rất chậm theo gió
  vec2 cq = vec2(p.x / (420.0 * s) + uSnow.y * 0.0006, p.y / (110.0 * s));
  float cl = vnoise(cq) * 0.6 + vnoise(cq * 2.3 + 7.0) * 0.4;
  col = mix(col, col * 1.35 + vec3(0.02, 0.02, 0.03), ss(0.45, 0.85, cl) * 0.5 * ss(0.05, 0.7, ny));
  return col;
}

// ---------------- 2. Pháo hoa & bụi tuyết rụng ----------------
vec3 bursts(vec3 col, vec2 p, float s, float hz, bool skyPass) {
  for (int i = 0; i < 4; i++) {
    vec4 b = uBursts[i];
    if (b.z < -50.0) continue;
    bool puff = b.w < 0.0;
    if (puff == skyPass) continue;
    float a = b.z;
    if (!puff) {
      vec3 hc = hue(b.w);
      if (a < 0.0) {
        // Pháo đang bay lên: vệt sáng từ thành phố lên điểm nổ
        float t = clamp(1.0 + a / 0.9, 0.0, 1.0);
        float ease = 1.0 - (1.0 - t) * (1.0 - t);
        vec2 start = vec2(b.x, hz + 10.0 * s);
        vec2 head = mix(start, b.xy, ease);
        vec2 tail = mix(start, b.xy, max(ease - 0.12, 0.0));
        float d = sdSeg(p, tail, head);
        col += vec3(1.0, 0.85, 0.6) * (cover(d - 0.8 * s, 1.2 * s) * 0.9 + exp(-d / (5.0 * s)) * 0.25);
        continue;
      }
      if (a > 2.6) continue;
      if (length(p - b.xy) > 190.0 * s) continue;
      float fade = pow(1.0 - a / 2.6, 1.4);
      // Chớp sáng lúc nổ hắt lên trời
      col += hc * exp(-length(p - b.xy) / (110.0 * s)) * 0.30 * exp(-a * 3.0);
      for (int k = 0; k < 26; k++) {
        float fk = float(k);
        float h = hash1(fk * 3.7 + b.w * 91.0);
        float ang = fk / 26.0 * 2.0 * PI + h * 0.2;
        vec2 dir = vec2(cos(ang), sin(ang));
        float v0 = (70.0 + 25.0 * h) * s;
        float a0 = max(a - 0.14, 0.0);
        vec2 pos = b.xy + dir * v0 * a * (1.0 - a * 0.22) + vec2(0.0, 16.0 * s * a * a);
        vec2 pos0 = b.xy + dir * v0 * a0 * (1.0 - a0 * 0.22) + vec2(0.0, 16.0 * s * a0 * a0);
        float d = sdSeg(p, pos0, pos);
        float tw = a > 1.4 ? step(0.35, hash1(fk + floor(uTime * 14.0))) : 1.0;
        col += hc * (cover(d - 1.0 * s, 1.2 * s) * 0.95 + exp(-d / (4.0 * s)) * 0.18) * fade * tw;
      }
    } else {
      // Bụi tuyết rụng từ cành thông: các cục tuyết nhỏ toả ra rồi rơi
      if (a > 1.8 || length(p - b.xy) > 150.0 * s) continue;
      float fade = 1.0 - a / 1.8;
      for (int k = 0; k < 14; k++) {
        float fk = float(k);
        float h = hash1(fk * 5.3 + b.x * 0.01);
        float h2 = hash1(fk * 2.1 + b.y * 0.01);
        vec2 v = vec2((h - 0.5) * 70.0, -20.0 - 30.0 * h2) * s;
        vec2 pos = b.xy + v * a + vec2(0.0, 90.0 * s * a * a);
        float r = (2.0 + 2.5 * h2) * s * (1.0 - a * 0.3);
        float d = length(p - pos) - r;
        col = mix(col, SNOW_LIT * 0.95, cover(d, 1.2 * s) * fade);
        col += vec3(0.6, 0.65, 0.75) * exp(-max(d, 0.0) / (6.0 * s)) * 0.10 * fade;
      }
    }
  }
  return col;
}

// ---------------- 3. Thành phố ----------------
vec3 city(vec3 col, vec2 p, float W, float hz, float s, float lights) {
  float nx = p.x / W;
  if (nx < 0.12 || nx > 0.88) return col;
  float env = exp(-pow((nx - 0.5) / 0.15, 2.0));
  float envWide = ss(0.14, 0.30, nx) * (1.0 - ss(0.70, 0.86, nx));
  // Hai lớp nhà: lớp sau mờ cao, lớp trước tối thấp
  for (int layer = 0; layer < 2; layer++) {
    float fl = float(layer);
    float cw = (layer == 0 ? 15.0 : 21.0) * s;
    float u = (p.x + fl * 7.0 * s) / cw;
    float cell = floor(u);
    float fx = fract(u);
    float h1 = hash1(cell * 1.37 + fl * 17.0);
    float h2 = hash1(cell * 2.91 + fl * 5.0);
    float g0 = 0.06 + 0.12 * hash1(cell * 4.1 + fl);
    float g1 = 0.94 - 0.12 * hash1(cell * 5.7 + fl);
    float hb = layer == 0 ? (10.0 + 26.0 * h1 + 108.0 * env * h2 * h2) : (6.0 + 16.0 * h1 + 46.0 * env * h2 * h2 * h2);
    hb *= s * envWide;
    if (hb < 2.0 * s) continue;
    float top = hz - hb + (layer == 1 ? 6.0 * s : 0.0);
    float inX = step(g0, fx) * step(fx, g1);
    // Ăng-ten trên toà cao nhất
    float tall = step(0.82, h2) * step(0.45, env);
    float antX = (g0 + g1) * 0.5;
    float dAnt = abs(fx - antX) * cw - 0.6 * s;
    float antTop = top - 24.0 * s * tall;
    if (tall > 0.5 && dAnt < 0.8 * s && p.y > antTop && p.y < top) col = mix(col, vec3(0.08, 0.09, 0.13), cover(dAnt, 1.0 * s));
    if (tall > 0.5) {
      float blink = pow(0.5 + 0.5 * sin(uTime * 2.4 + cell), 6.0);
      float dl = length(p - vec2((cell + antX) * cw - fl * 7.0 * s, antTop));
      col += vec3(1.0, 0.18, 0.15) * (cover(dl - 1.6 * s, 1.0 * s) * (0.35 + 0.65 * blink) + exp(-dl / (7.0 * s)) * 0.45 * blink);
    }
    if (inX < 0.5 || p.y < top || p.y > hz + 6.0 * s) continue;
    vec3 bc = layer == 0 ? vec3(0.10, 0.11, 0.17) : vec3(0.055, 0.06, 0.095);
    bc = mix(bc, bc * 1.4, ss(g0, g0 + 0.15, fx) * 0.0 + (1.0 - ss(g0, g0 + 0.25, fx)) * 0.25);
    // Cửa sổ sáng: lưới ô nhỏ, bật tắt chậm theo thời gian
    float wy = (p.y - top) / (4.2 * s);
    float wx = (fx - g0) / (g1 - g0) * floor((g1 - g0) * cw / (3.6 * s) + 0.5);
    vec2 wc = vec2(floor(wx), floor(wy));
    vec2 wf = vec2(fract(wx), fract(wy));
    float slot = floor(uTime / 9.0 + hash2(wc + cell * 3.0) * 9.0);
    float on = step(1.0 - lights * (layer == 0 ? 0.55 : 0.45), hash2(wc * 1.7 + vec2(cell, slot * 0.37 + fl)));
    float win = step(0.25, wf.x) * step(wf.x, 0.75) * step(0.3, wf.y) * step(wf.y, 0.8) * step(1.0, wy);
    vec3 wcol = mix(WARM, vec3(0.80, 0.88, 1.0), step(0.7, hash2(wc + cell)));
    bc = mix(bc, wcol * (layer == 0 ? 0.75 : 0.95), win * on);
    col = bc;
  }
  return col;
}

// Đồng bằng thành phố dưới chân dãy nhà: đèn đường dày đặc & dòng xe trên cao tốc
vec3 cityPlain(vec3 col, vec2 p, float W, float hz, float s, float lights) {
  float depth = (p.y - hz) / (46.0 * s);
  if (depth < 0.0 || depth > 1.0) return col;
  float nx = p.x / W;
  col = mix(col, vec3(0.05, 0.05, 0.08), ss(0.0, 0.08, depth));
  // Hàng đèn thưa dần khi lại gần (dày ở xa)
  float rowH = mix(2.4, 6.0, depth) * s;
  vec2 g = vec2(p.x / (mix(3.0, 8.0, depth) * s), (p.y - hz) / rowH);
  vec2 gi = floor(g);
  float h = hash2(gi + 13.0);
  vec2 c = fract(g) - 0.5 - (vec2(hash2(gi + 2.0), hash2(gi + 5.0)) - 0.5) * 0.5;
  float r = length(c * vec2(1.0, 1.4));
  float spread = ss(0.06, 0.24, nx) * (1.0 - ss(0.76, 0.94, nx));
  float dens = lights * spread * mix(0.55, 0.25, depth);
  float tw = 0.75 + 0.25 * sin(uTime * (0.8 + h * 2.0) + h * 30.0);
  vec3 lc = mix(vec3(1.0, 0.70, 0.40), vec3(0.95, 0.92, 0.85), step(0.65, hash2(gi + 9.0)));
  col += lc * ss(0.45, 0.15, r) * step(1.0 - dens, h) * tw * mix(0.9, 0.6, depth);
  // Cao tốc chéo: xe đèn trắng đi vào, đèn đỏ đi ra
  vec2 A = vec2(0.30 * W, hz + 44.0 * s), B = vec2(0.53 * W, hz + 3.0 * s);
  vec2 ab = B - A;
  float t = clamp(dot(p - A, ab) / dot(ab, ab), 0.0, 1.0);
  vec2 cp = A + ab * t;
  vec2 nrm = normalize(vec2(-ab.y, ab.x));
  float side = dot(p - cp, nrm);
  col += vec3(0.9, 0.55, 0.25) * cover(abs(side) - 1.4 * s * (1.0 - t * 0.7), 1.0 * s) * 0.10 * lights;
  for (int lane = 0; lane < 2; lane++) {
    float dir = lane == 0 ? 1.0 : -1.0;
    float off = (lane == 0 ? -1.1 : 1.1) * s * (1.0 - t * 0.6);
    float ph = t * 22.0 - dir * uTime * 0.55;
    float carI = floor(ph);
    float cf = fract(ph);
    float present = step(0.45, hash1(carI * 3.1 + float(lane) * 7.0));
    float d = length(vec2((cf - 0.5) * length(ab) / 22.0, side - off)) - 0.9 * s * (1.0 - t * 0.5);
    vec3 cc = lane == 0 ? vec3(1.0, 0.95, 0.85) : vec3(1.0, 0.22, 0.18);
    col += cc * cover(d, 1.0 * s) * present * lights;
  }
  return col;
}

// ---------------- 4. Đồi tối hai lớp ----------------
float hillTop(float x, float W, float hz, float s, float base, float rise, float pw, float seed) {
  float ax = abs(x / W - 0.5) * 2.0;
  return hz + base * s - rise * s * pow(ax, pw) + (vnoise(vec2(x / (90.0 * s), seed)) - 0.5) * 14.0 * s;
}

vec3 hills(vec3 col, vec2 p, float W, float hz, float s, float lights) {
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float top = i == 0 ? hillTop(p.x, W, hz, s, 58.0, 92.0, 1.5, 3.0) : hillTop(p.x, W, hz, s, 104.0, 96.0, 1.25, 9.0);
    if (p.y < top - 2.0 * s) continue;
    vec3 hc = i == 0 ? vec3(0.055, 0.065, 0.10) : vec3(0.035, 0.042, 0.068);
    // Mảng tuyết loang trên sườn đồi
    float n = vnoise(p / (vec2(60.0, 18.0) * s) + fi * 11.0) * 0.7 + vnoise(p / (14.0 * s) + fi * 3.0) * 0.3;
    float patchy = ss(0.52, 0.60, n) * ss(top, top + 30.0 * s, p.y);
    hc = mix(hc, (i == 0 ? vec3(0.20, 0.23, 0.31) : vec3(0.15, 0.17, 0.25)), patchy * 0.8);
    // Viền tuyết sáng nhẹ trên đỉnh đồi
    hc = mix(hc, vec3(0.28, 0.31, 0.40), cover(abs(p.y - top - 1.5 * s) - 1.2 * s, 1.0 * s) * 0.6);
    // Đèn nhà lấm tấm
    vec2 g = p / (vec2(26.0, 14.0) * s) + fi * 5.0;
    vec2 gi = floor(g);
    float h = hash2(gi + 31.0 + fi);
    vec2 c = fract(g) - 0.5 - (vec2(hash2(gi + 1.0), hash2(gi + 4.0)) - 0.5) * 0.6;
    float lamp = step(1.0 - 0.10 * lights, h) * step(top + 6.0 * s, p.y);
    float dl = length(c * vec2(26.0, 14.0) * s);
    hc += WARM * (cover(dl - 1.2 * s, 1.0 * s) * 0.9 + exp(-dl / (6.0 * s)) * 0.25) * lamp;
    col = mix(col, hc, cover(top - p.y, 1.2 * s));
  }
  return col;
}

// ---------------- 5. Đồi tuyết phía trước ----------------
float ridgeY(float x, float A, float s) {
  return A * 0.645 + 6.0 * s * sin(x / (140.0 * s)) + 4.0 * s * sin(x / (53.0 * s) + 1.0);
}

vec3 snowField(vec3 col, vec2 p, float W, float A, float s, vec2 kidPos, float showKid) {
  float top = ridgeY(p.x, A, s);
  if (p.y < top - 2.0 * s) return col;
  // Ánh đèn mềm chiếu xuống giữa đồi
  vec2 lq = (p - vec2(0.5 * W, 0.80 * A)) / vec2(0.46 * W, 0.34 * A);
  float L = exp(-dot(lq, lq) * 1.2);
  // Gò tuyết nhấp nhô: đổ bóng theo độ dốc của nhiễu
  // Gò dẹt theo phối cảnh (kéo ngang), lấy dốc qua sai phân rộng để mặt tuyết mượt, không lốm đốm
  vec2 sc = vec2(220.0, 70.0) * s;
  float n0 = vnoise(p / sc + 3.0);
  float nx = vnoise((p + vec2(14.0 * s, 0.0)) / sc + 3.0);
  float ny = vnoise((p + vec2(0.0, 6.0 * s)) / sc + 3.0);
  float slope = (nx - n0) * 0.8 + (ny - n0) * 1.4;
  vec3 c = mix(SNOW_SHADE, SNOW_LIT, clamp(L * 0.95 + 0.08 - slope * 2.2, 0.0, 1.0));
  // Mép đồi tối hơn (phía xa, khuất sáng) và viền sáng mảnh
  c = mix(c, SNOW_DEEP * 1.3, ss(top + 26.0 * s, top, p.y) * 0.55);
  c = mix(c, vec3(0.70, 0.76, 0.90), cover(abs(p.y - top - 1.2 * s) - 0.9 * s, 1.0 * s) * 0.7);

  // Dấu chân dẫn từ góc phải tới chiếc xe
  if (showKid > 0.5) {
    vec2 P0 = vec2(0.93 * W, 1.02 * A), P1 = vec2(0.70 * W, 0.86 * A), P2 = kidPos + vec2(150.0 * s, -6.0 * s);
    for (int k = 0; k < 11; k++) {
      float t = (float(k) + 0.5) / 11.0;
      vec2 pt = mix(mix(P0, P1, t), mix(P1, P2, t), t);
      vec2 tg = normalize(mix(P1 - P0, P2 - P1, t));
      vec2 nr = vec2(-tg.y, tg.x);
      float sc = mix(1.35, 0.85, t) * s;
      vec2 fp = pt + nr * (mod(float(k), 2.0) < 1.0 ? 5.0 : -5.0) * sc;
      vec2 q = p - fp;
      vec2 lq2 = vec2(dot(q, tg), dot(q, nr)) / sc;
      float d = length(lq2 / vec2(7.0, 3.6)) - 1.0;
      if (d < 0.6) {
        c = mix(c, mix(SNOW_SHADE, c, 0.45), cover(d * 3.6, 1.0 / sc * s) * 0.85);
        c = mix(c, SNOW_LIT, cover(abs(d - 0.18) * 3.6 - 0.5, 1.0) * step(0.0, lq2.y) * 0.25);
      }
    }
  }
  // Lấp lánh tinh thể tuyết
  vec2 g = p / (9.0 * s);
  vec2 gi = floor(g);
  float h = hash2(gi + 77.0);
  if (h > 0.985) {
    float tw = pow(max(sin(uTime * (0.7 + h * 3.0) + h * 50.0), 0.0), 8.0);
    float d = length(fract(g) - 0.5);
    c += vec3(0.9, 0.95, 1.0) * ss(0.2, 0.0, d) * tw * (0.3 + 0.7 * L);
  }
  return mix(col, c, cover(top - p.y, 1.2 * s));
}

// ---------------- 6. Thông phủ tuyết ----------------
void pineTree(inout vec3 col, vec2 p, vec2 base, float Ht, float s, float sway, float seed) {
  float halfW = Ht * 0.30;
  if (abs(p.x - base.x) > halfW * 1.3 + 30.0 * s || p.y < base.y - Ht - 10.0 * s || p.y > base.y + 6.0 * s) return;
  float up = clamp((base.y - p.y) / Ht, 0.0, 1.0);
  vec2 q = p - base;
  q.x -= sway * Ht * 0.06 * up * up;
  float dTrunk = sdBox(q - vec2(0.0, -Ht * 0.08), vec2(Ht * 0.025, Ht * 0.09), 1.0 * s);
  float d = dTrunk;
  float snowAmt = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float t0 = 0.10 + fi * 0.15;              // đáy tầng (tính từ gốc lên)
    float tTop = min(t0 + 0.30, 1.0);          // đỉnh tầng
    float yB = -Ht * t0, yT = -Ht * tTop;
    float wB = halfW * (1.0 - t0 * 0.85) * (0.92 + 0.12 * hash1(seed + fi));
    float k = clamp((q.y - yT) / (yB - yT), 0.0, 1.0);
    float droop = sin(abs(q.x) / max(wB, 1.0) * PI) * Ht * 0.012;
    float edge = wB * k;
    float scallop = (vnoise(vec2(q.x / (6.0 * s), seed + fi)) - 0.5) * 4.0 * s;
    float dt = max(abs(q.x) - edge, max(yT - q.y, q.y - (yB + droop + scallop)));
    d = min(d, dt);
    // Tuyết chỉ đọng thành dải mỏng ở nửa trên mép dốc của mỗi tầng
    float distSlope = (edge - abs(q.x)) * 0.9;
    float thick = Ht * 0.010 * (0.6 + vnoise(vec2(q.x / (5.0 * s), fi + seed)) * 1.4);
    float sn = cover(distSlope - thick, 1.2 * s) * step(dt, 0.5 * s);
    sn *= 1.0 - ss(0.35, 0.75, k);
    snowAmt = max(snowAmt, sn * step(yT, q.y));
  }
  if (d > 1.5 * s) return;
  vec3 tc = vec3(0.035, 0.065, 0.075);
  tc = mix(tc, vec3(0.06, 0.035, 0.03), step(dTrunk, d + 0.01) * step(-Ht * 0.17, q.y));
  tc = mix(tc, mix(vec3(0.42, 0.47, 0.60), vec3(0.72, 0.76, 0.88), ss(0.0, -halfW, q.x)), snowAmt);
  col = mix(col, tc, cover(d, 1.2 * s));
}

vec3 trees(vec3 col, vec2 p, float W, float A, float s, float sway) {
  // Bên trái
  pineTree(col, p, vec2(0.205 * W, ridgeY(0.205 * W, A, s) + 4.0 * s), 150.0 * s, s, sway * 0.7, 3.0);
  pineTree(col, p, vec2(0.125 * W, ridgeY(0.125 * W, A, s) + 14.0 * s), 235.0 * s, s, sway * 0.85, 7.0);
  pineTree(col, p, vec2(0.035 * W, ridgeY(0.035 * W, A, s) + 30.0 * s), 330.0 * s, s, sway, 11.0);
  // Bên phải
  pineTree(col, p, vec2(0.785 * W, ridgeY(0.785 * W, A, s) + 4.0 * s), 140.0 * s, s, sway * 0.7, 5.0);
  pineTree(col, p, vec2(0.862 * W, ridgeY(0.862 * W, A, s) + 16.0 * s), 225.0 * s, s, sway * 0.85, 13.0);
  pineTree(col, p, vec2(0.960 * W, ridgeY(0.960 * W, A, s) + 34.0 * s), 345.0 * s, s, sway, 17.0);
  return col;
}

// ---------------- 7. Phi hành gia kéo violin trên nóc xe đỏ ----------------
float sdQuad(vec2 p, vec2 v0, vec2 v1, vec2 v2, vec2 v3) {
  vec2 v[4];
  v[0] = v0; v[1] = v1; v[2] = v2; v[3] = v3;
  float d = dot(p - v[0], p - v[0]);
  float sg = 1.0;
  int j = 3;
  for (int i = 0; i < 4; i++) {
    vec2 e = v[j] - v[i];
    vec2 w = p - v[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bool c1 = p.y >= v[i].y;
    bool c2 = p.y < v[j].y;
    bool c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sg = -sg;
    j = i;
  }
  return sg * sqrt(d);
}
float sdCapsule(vec2 p, vec2 a, vec2 b, float r) { return sdSeg(p, a, b) - r; }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// Bộ đồ trắng: sáng phía trên-trái (ánh phố), tối dần phía dưới-phải
vec3 suitShade(vec2 q, vec2 c, float r) {
  float k = clamp(dot(q - c, normalize(vec2(0.6, 0.8))) / r, -1.0, 1.0);
  return mix(vec3(0.95, 0.95, 0.97), vec3(0.55, 0.60, 0.72), ss(-0.3, 1.0, k));
}

vec3 musician(vec3 col, vec2 p, vec2 pos, float s) {
  vec2 q = (p - pos) / s;
  // Đèn pha hắt quầng ấm xuống tuyết phía trước-trái (tắt dần mềm, không bị cắt theo khung)
  {
    vec2 g = (q - vec2(-240.0, -6.0)) / vec2(130.0, 24.0);
    float e = dot(g, g);
    if (e < 9.0) col += vec3(1.0, 0.86, 0.60) * exp(-e) * 0.26;
  }
  // Bóng xe trên tuyết
  {
    float dSh = sdBox(q - vec2(4.0, -4.0), vec2(170.0, 10.0), 10.0);
    if (dSh < 40.0) col = mix(col, SNOW_SHADE * 0.75, cover(dSh, 18.0) * 0.55);
  }
  if (q.x < -200.0 || q.x > 200.0 || q.y < -330.0 || q.y > 14.0) return col;
  float aa = 1.2 / s;
  float bow = uKid.x, sway = uKid.y, inten = uKid.z;

  vec3 red = vec3(0.80, 0.13, 0.15), redLit = vec3(0.95, 0.32, 0.30), redDk = vec3(0.45, 0.06, 0.09);
  vec3 snowCap = vec3(0.90, 0.93, 1.0);

  // --- Xe ---
  // Mặt hông
  float dSide = sdQuad(q, vec2(-150.0, -26.0), vec2(152.0, -28.0), vec2(154.0, -72.0), vec2(-142.0, -70.0));
  if (dSide < aa) {
    vec3 c = mix(redLit, red, ss(-70.0, -55.0, q.y));
    c = mix(c, redDk, ss(-40.0, -26.0, q.y) * 0.8);
    c = mix(c, vec3(0.75, 0.75, 0.80), cover(abs(q.y + 31.0) - 1.2, aa) * 0.7);                       // nẹp chrome
    c = mix(c, redDk, cover(abs(q.x + 30.0 + (q.y + 30.0) * 0.05) - 0.9, aa) * step(-70.0, q.y) * 0.8); // khe cửa
    c = mix(c, redDk * 0.7, cover(sdBox(q - vec2(-12.0, -60.0), vec2(8.0, 1.6), 1.0), aa));            // tay nắm
    col = mix(col, c, cover(dSide, aa));
  }
  // Mặt đầu xe (mũi) quay sang trái
  float dNose = sdQuad(q, vec2(-170.0, -28.0), vec2(-150.0, -26.0), vec2(-142.0, -70.0), vec2(-163.0, -64.0));
  if (dNose < aa) {
    vec3 c = mix(red * 0.85, redDk, ss(-60.0, -30.0, q.y));
    float dGr = sdQuad(q, vec2(-166.0, -38.0), vec2(-151.0, -36.0), vec2(-148.0, -48.0), vec2(-163.0, -49.0));
    c = mix(c, vec3(0.08, 0.07, 0.09), cover(dGr, aa));
    float dHl = sdQuad(q, vec2(-163.0, -51.0), vec2(-148.0, -50.0), vec2(-146.0, -60.0), vec2(-161.0, -59.0));
    c = mix(c, vec3(1.0, 0.95, 0.78), cover(dHl, aa));
    col = mix(col, c, cover(dNose, aa));
    col += vec3(1.0, 0.85, 0.55) * exp(-max(dHl, 0.0) / 8.0) * 0.35 * step(0.0, dHl);
  }
  // Nắp capo phủ tuyết
  float dHood = sdQuad(q, vec2(-163.0, -64.0), vec2(-142.0, -70.0), vec2(-58.0, -78.0), vec2(-150.0, -74.0));
  if (dHood < aa) {
    vec3 c = mix(redLit, red, 0.3);
    float sn = ss(-71.0 + sin(q.x * 0.15) * 1.5, -75.0, q.y);
    c = mix(c, mix(snowCap, SNOW_SHADE, 0.2), sn);
    col = mix(col, c, cover(dHood, aa));
  }
  // Đèn hậu
  col = mix(col, vec3(1.0, 0.30, 0.18), cover(sdBox(q - vec2(150.0, -54.0), vec2(3.0, 9.0), 1.5), aa));
  // Cabin & kính
  float dCab = sdQuad(q, vec2(-60.0, -72.0), vec2(116.0, -70.0), vec2(84.0, -118.0), vec2(-22.0, -120.0));
  if (dCab < aa) {
    vec3 c = red;
    float dWs = sdQuad(q, vec2(-54.0, -75.0), vec2(-34.0, -75.0), vec2(-12.0, -114.0), vec2(-22.0, -115.0));
    float dWin = sdQuad(q, vec2(-27.0, -76.0), vec2(106.0, -74.0), vec2(78.0, -113.0), vec2(-6.0, -114.0));
    float dGlass = min(dWs, dWin);
    vec3 gc = mix(vec3(0.10, 0.12, 0.20), vec3(0.30, 0.30, 0.42), ss(-76.0, -114.0, q.y));
    gc += vec3(0.9, 0.6, 0.4) * ss(0.06, 0.0, abs(fract((q.x + q.y * 0.8) / 70.0) - 0.5)) * 0.18;
    c = mix(c, gc, cover(dGlass, aa));
    c = mix(c, red * 0.9, cover(abs(q.x - 38.0 + (q.y + 74.0) * 0.15) - 3.0, aa) * step(dWin, 0.0));   // trụ B
    col = mix(col, c, cover(dCab, aa));
  }
  // Tuyết trên nóc xe
  {
    float top = -120.0 + (vnoise(vec2(q.x * 0.08, 2.0)) - 0.5) * 4.0;
    float dSn = max(max(q.y + 114.0, top - 5.0 - q.y), max(-24.0 - q.x, q.x - 86.0));
    col = mix(col, mix(snowCap, SNOW_SHADE, ss(-122.0, -114.0, q.y) * 0.5), cover(dSn, aa));
  }
  // Bánh xe trong hốc
  for (int i = 0; i < 2; i++) {
    vec2 wc = i == 0 ? vec2(-100.0, -22.0) : vec2(104.0, -22.0);
    float dArch = max(length(q - wc) - 28.0, q.y - 6.0);
    col = mix(col, vec3(0.05, 0.04, 0.06), cover(dArch, aa));
    float r = length(q - wc);
    float dT = r - 22.0;
    if (dT < aa) {
      vec3 tc = vec3(0.10, 0.10, 0.12);
      tc = mix(tc, vec3(0.62, 0.64, 0.70), cover(r - 11.0, aa));
      tc = mix(tc, vec3(0.35, 0.36, 0.40), cover(r - 4.0, aa));
      col = mix(col, tc, cover(dT, aa));
    }
  }
  // Đụn tuyết nhỏ vùi chân mỗi bánh
  for (int i = 0; i < 2; i++) {
    vec2 wc = i == 0 ? vec2(-100.0, 0.0) : vec2(104.0, 0.0);
    vec2 mq = (q - wc) / vec2(38.0, 10.0);
    float dM = (length(mq) - 1.0) * 10.0 + sin(q.x * 0.2 + float(i)) * 1.2;
    col = mix(col, mix(SNOW_LIT, SNOW_SHADE, ss(-10.0, 4.0, q.y) * 0.35), cover(dM, aa));
  }

  // --- Phi hành gia ---
  vec2 hip = vec2(14.0, -126.0);
  // Chân (chân phía sau vẽ trước, tối hơn)
  for (int i = 0; i < 2; i++) {
    vec2 o = i == 0 ? vec2(8.0, 2.0) : vec2(0.0);
    float dk = i == 0 ? 0.82 : 1.0;
    vec2 knee = vec2(-30.0, -130.0) + o;
    vec2 ankle = vec2(-40.0, -94.0) + o + vec2(sin(uTime * 1.3 + float(i)) * 1.5, 0.0);
    float dLeg = min(sdCapsule(q, hip + o, knee, 10.0), sdCapsule(q, knee, ankle, 9.0));
    if (dLeg < aa) col = mix(col, suitShade(q, knee, 30.0) * dk, cover(dLeg, aa));
    float dBoot = sdCapsule(q, ankle, ankle + vec2(-12.0, 6.0), 9.5);
    if (dBoot < aa) col = mix(col, mix(vec3(0.72, 0.74, 0.80), vec3(0.40, 0.42, 0.50), ss(-8.0, 8.0, q.y - ankle.y)) * dk, cover(dBoot, aa));
  }
  // Thân trên đung đưa quanh hông theo nhịp nhạc
  vec2 u = hip + rot2(-sway * 0.06) * (q - hip);
  // Ba lô dưỡng sinh
  float dPack = sdBox(u - vec2(42.0, -154.0), vec2(12.0, 25.0), 5.0);
  if (dPack < aa) col = mix(col, mix(vec3(0.78, 0.80, 0.84), vec3(0.45, 0.48, 0.56), ss(30.0, 54.0, u.x)), cover(dPack, aa));
  // Thân
  float dTorso = sdBox(rot2(0.08) * (u - vec2(20.0, -150.0)), vec2(21.0, 27.0), 12.0);
  if (dTorso < aa) {
    vec3 c = suitShade(u, vec2(10.0, -165.0), 40.0);
    c = mix(c, vec3(0.30, 0.32, 0.38), cover(sdBox(u - vec2(14.0, -150.0), vec2(9.0, 6.0), 2.0), aa));
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec3 lc = i == 0 ? vec3(1.0, 0.3, 0.25) : (i == 1 ? vec3(0.3, 1.0, 0.5) : vec3(0.3, 0.7, 1.0));
      float on = step(0.0, sin(uTime * (1.5 + fi * 0.7) + fi * 2.0));
      c = mix(c, lc, cover(length(u - vec2(9.0 + fi * 5.0, -150.0)) - 1.6, aa) * (0.35 + 0.65 * on));
    }
    c = mix(c, vec3(0.85, 0.20, 0.20), cover(sdBox(u - vec2(30.0, -162.0), vec2(4.0, 2.5), 0.5), aa));   // phù hiệu vai
    col = mix(col, c, cover(dTorso, aa));
  }
  // Cây violin
  vec2 vc = vec2(-8.0, -166.0);
  vec2 vn = normalize(vec2(-1.0, -0.18));
  vec2 vp = vec2(-vn.y, vn.x);
  vec2 lu = vec2(dot(u - vc, vn), dot(u - vc, vp));
  float dViolin = min(length(lu - vec2(-6.0, 0.0)) - 8.5, length(lu - vec2(9.0, 0.0)) - 10.5);
  dViolin = max(dViolin, -(length(lu - vec2(2.0, 11.0)) - 3.5));
  dViolin = max(dViolin, -(length(lu - vec2(2.0, -11.0)) - 3.5));
  float dNeck = min(sdCapsule(lu, vec2(-12.0, 0.0), vec2(-40.0, 0.0), 2.4), length(lu - vec2(-43.0, 0.0)) - 3.2);
  vec2 hand = vc + vn * 34.0;
  // Tay trái giữ cần đàn
  {
    vec2 sh = vec2(6.0, -168.0), el = vec2(-12.0, -150.0);
    float dA = min(sdCapsule(u, sh, el, 7.5), sdCapsule(u, el, hand, 7.0));
    if (dA < aa) col = mix(col, suitShade(u, el, 20.0), cover(dA, aa));
  }
  if (min(dViolin, dNeck) < aa) {
    vec3 c = dViolin < dNeck ? mix(vec3(0.78, 0.42, 0.16), vec3(0.42, 0.18, 0.07), ss(-10.0, 10.0, lu.y)) : vec3(0.12, 0.08, 0.06);
    c = mix(c, vec3(0.12, 0.08, 0.06), cover(sdBox(lu - vec2(-2.0, 0.0), vec2(9.0, 1.6), 0.8), aa) * step(dViolin, 0.0));
    col = mix(col, c, cover(min(dViolin, dNeck), aa));
    col = mix(col, vec3(0.9, 0.85, 0.7), cover(abs(lu.y) - 0.35, aa) * step(-40.0, lu.x) * step(lu.x, 12.0) * 0.6);
  }
  col = mix(col, vec3(0.92, 0.92, 0.95), cover(length(u - hand) - 6.0, aa));            // găng tay trái
  // Vĩ đàn trượt dọc trục của nó
  vec2 cb = vc + vn * 1.0;
  vec2 dirB = normalize(vec2(0.92, 0.50));
  vec2 bh = cb + dirB * (24.0 + 28.0 * (bow + 1.0));
  vec2 bt = bh - dirB * 100.0;
  vec2 bnrm = vec2(-dirB.y, dirB.x);
  col = mix(col, vec3(0.30, 0.16, 0.08), cover(sdSeg(u, bh, bt) - 1.1, aa));
  col = mix(col, vec3(0.92, 0.90, 0.82), cover(sdSeg(u, bh + bnrm * 3.0, bt + bnrm * 2.0) - 0.4, aa) * 0.8);
  // Tay phải kéo vĩ
  {
    vec2 sh = vec2(34.0, -166.0);
    vec2 mid = mix(sh, bh, 0.5);
    vec2 nn = normalize(vec2(bh.y - sh.y, -(bh.x - sh.x)));
    vec2 el = mid + nn * 13.0;
    float dA = min(sdCapsule(u, sh, el, 7.5), sdCapsule(u, el, bh, 7.0));
    if (dA < aa) col = mix(col, suitShade(u, el, 20.0), cover(dA, aa));
    col = mix(col, vec3(0.92, 0.92, 0.95), cover(length(u - bh) - 6.0, aa));
  }
  // Cổ áo & mũ bảo hộ, kính phản chiếu ánh phố
  col = mix(col, vec3(0.62, 0.65, 0.72), cover(sdBox(u - vec2(18.0, -176.0), vec2(14.0, 4.0), 2.0), aa));
  vec2 hc = vec2(16.0, -197.0);
  float dHelm = length(u - hc) - 22.0;
  if (dHelm < aa) {
    vec3 c = suitShade(u, hc, 22.0);
    vec2 vq = rot2(0.12) * (u - hc - vec2(-5.0, 1.0));
    float dVisor = length(vq / vec2(15.5, 12.5)) - 1.0;
    vec3 vc2 = mix(vec3(0.05, 0.06, 0.11), vec3(0.20, 0.16, 0.22), ss(-12.0, 12.0, vq.y));
    vc2 += vec3(1.0, 0.75, 0.45) * exp(-pow((vq.y - 4.0) / 2.5, 2.0)) * ss(-15.0, 5.0, vq.x) * 0.35;   // dải đèn phố
    vc2 = mix(vc2, vec3(0.95, 0.97, 1.0), cover(abs(length(vq - vec2(4.0, 4.0)) - 10.0) - 1.0, aa) * step(vq.y, -2.0) * step(vq.x, 2.0) * 0.6);
    c = mix(c, vc2, cover(dVisor * 12.5, aa));
    col = mix(col, c, cover(dHelm, aa));
  }

  // Nốt nhạc bay lên từ cây đàn
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    float a = fract(uKid.w + fk / 4.0);
    vec2 np = vc + vec2(-14.0 - 46.0 * a + sin(a * 7.0 + fk * 2.0) * 9.0, -16.0 - 110.0 * a);
    float alpha = sin(a * PI) * (0.45 + 0.55 * inten);
    vec2 nq = q - np;
    float head = length(rot2(0.35) * nq / vec2(4.6, 3.4)) - 1.0;
    float stem = sdSeg(nq, vec2(4.0, -1.0), vec2(4.0, -16.0)) - 0.9;
    float flag = mod(fk, 2.0) < 1.0 ? sdSeg(nq, vec2(4.0, -16.0), vec2(10.0, -9.0)) - 0.9 : sdSeg(nq, vec2(4.0, -16.0), vec2(16.0, -18.0)) - 1.4;
    float dN = min(head * 3.4, min(stem, flag));
    vec3 nc = vec3(1.0, 0.88, 0.55);
    col = mix(col, nc, cover(dN, aa) * alpha);
    col += nc * exp(-max(dN, 0.0) / 6.0) * 0.12 * alpha;
  }
  return col;
}

// ---------------- 8. Đụn tuyết ôm biểu tượng ----------------
vec3 iconDrift(vec3 col, vec2 p, float s, float dI) {
  // Bóng xanh đổ xuống phía dưới-phải
  if (dI > 0.0) {
    float dSh = iconField(p - vec2(8.0, 10.0) * s);
    col = mix(col, col * vec3(0.55, 0.62, 0.80), cover(dSh, 10.0 * s) * 0.55);
  }
  if (dI > 1.5 * s) return col;
  float gx = iconField(p + vec2(3.0, 0.0)) - iconField(p - vec2(3.0, 0.0));
  float gy = iconField(p + vec2(0.0, 3.0)) - iconField(p - vec2(0.0, 3.0));
  // Đụn tuyết trong bóng đêm: xanh lam dịu, mép trên bắt ánh đèn thành phố
  float n = vnoise(p / (70.0 * s)) * 0.6 + vnoise(p / (23.0 * s)) * 0.4;
  vec3 c = mix(vec3(0.30, 0.36, 0.50), vec3(0.44, 0.50, 0.64), n);
  float rim = ss(-20.0 * s, 0.0, dI);
  float face = clamp(gy * 0.35 + gx * 0.15, -1.0, 1.0);    // mép trên sáng, mép dưới xanh bóng
  c = mix(c, face < 0.0 ? vec3(0.80, 0.84, 0.94) : SNOW_DEEP, abs(face) * rim * 0.9);
  // Lấp lánh
  vec2 g = p / (8.0 * s);
  float h = hash2(floor(g) + 41.0);
  if (h > 0.98) c += vec3(0.9, 0.95, 1.0) * ss(0.22, 0.0, length(fract(g) - 0.5)) * pow(max(sin(uTime * (0.6 + h * 2.0) + h * 40.0), 0.0), 8.0) * 0.8;
  return mix(col, c, cover(dI, 1.4 * s));
}

// ---------------- 9. Tuyết rơi ----------------
vec3 snowfall(vec3 col, vec2 p, float s, float amount) {
  if (amount < 0.01) return col;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float cs = (i == 0 ? 34.0 : (i == 1 ? 58.0 : 96.0)) * s;
    float spd = (i == 0 ? 26.0 : (i == 1 ? 44.0 : 78.0)) * s;
    float drift = uSnow.y * (0.35 + 0.35 * fi) * s;
    vec2 q = p - vec2(drift, uSnow.x * spd);
    // Nghiêng nhẹ theo gió
    q.x -= (q.y) * uSnow.z * 0.18;
    vec2 cell = floor(q / cs);
    vec2 cm = mod(cell, 64.0);
    float h = hash2(cm + fi * 17.0);
    if (h > amount * (0.55 + 0.25 * fi) + 0.08) continue;
    vec2 c = (vec2(hash2(cm + 3.0 + fi), hash2(cm + 9.0 + fi)) * 0.6 + 0.2) * cs;
    c.x += sin(uTime * (0.6 + h) + h * 20.0) * cs * 0.14;
    float r = (i == 0 ? 0.9 : (i == 1 ? 1.5 : 2.6)) * s * (0.7 + 0.6 * h);
    float d = length(fract(q / cs) * cs - c) - r;
    float soft = i == 2 ? 2.2 * s : 1.0 * s;
    col = mix(col, vec3(0.93, 0.95, 1.0), cover(d, soft) * (i == 0 ? 0.55 : (i == 1 ? 0.75 : 0.85)));
  }
  return col;
}

// ---------------- Hàm chính ----------------
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y * uScale - gl_FragCoord.y) / uScale;
  float W = uRes.x, H = uRes.y;
  float A = max(280.0, H - 48.0);
  float s = min(W / 1280.0, A / 720.0);
  float hz = A * 0.46;
  float amount = uScene.x, lights = uScene.y, showKid = uScene.z;
  vec2 kidPos = vec2(0.5 * W, 0.86 * A);

  vec3 col = sky(p, W, hz, s, lights);
  col = bursts(col, p, s, hz, true);
  col = city(col, p, W, hz, s, lights);
  col = cityPlain(col, p, W, hz, s, lights);
  col = hills(col, p, W, hz, s, lights);
  col = snowField(col, p, W, A, s, kidPos, showKid);
  col = trees(col, p, W, A, s, uSnow.w);
  if (showKid > 0.5) col = musician(col, p, kidPos, s * 1.05);
  col = bursts(col, p, s, hz, false);

  float dI = iconField(p);
  if (dI < 24.0 * s) col = iconDrift(col, p, s, dI);

  col = snowfall(col, p, s, amount);

  // Viền tối nhẹ quanh khung
  vec2 vq = (p - vec2(0.5 * W, 0.5 * H)) / vec2(W, H);
  col *= 1.0 - dot(vq, vq) * 0.45;
  col += (hash2(p + fract(uSeed) * 100.0) - 0.5) / 255.0;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}
