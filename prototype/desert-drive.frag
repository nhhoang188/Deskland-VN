#version 300 es
// Deskland · Cung đường sa mạc (Desert Highway)
// Dùng chung cho cả prototype/desert-drive.html (WebGL2) và deskland-rs (OpenGL 3.3).
// Tranh phẳng kiểu minh họa retro: trời xanh nhạt chuyển kem đào, vầng dương lớn sau dãy núi tím,
// khối núi sa thạch giật cấp bên phải, đồng cát cam với bụi cây xám xanh, cây Joshua,
// con đường thẳng tắp hút về điểm tụ và chiếc xe thể thao 80s màu hồng nhìn từ phía sau.
// Mọi thứ trên mặt đất nằm trong toạ độ thế giới (X ngang, Z sâu) nên trôi đúng phối cảnh;
// quãng đường đã chạy (uCar.w) được cộng dồn bên CPU nên đổi tốc độ không bị giật pha,
// còn vạch kẻ/khe nứt được lọc hộp theo quãng đường của một khung hình (uDrive.x) để mượt cả ở 20 FPS.

precision highp float;

uniform sampler2D uNoise, uFA, uFB;
uniform vec2 uRes, uGrid;
uniform float uScale, uSeed, uStep, uMix, uTime, uDebug;

uniform vec4 uScene;   // x=tod (0..1), y=speed, z=boost (0..1), w=carColor (0..3)
uniform vec4 uCar;     // x=carLane (-1..1), y=bob (px), z=steerTilt, w=quãng đường (đơn vị thế giới, quấn vòng 660)
uniform vec4 uEffects; // x=flame (0..1), y=signalL, z=signalR, w=độ rung camera (px)
uniform vec4 uDrive;   // x=quãng đường trong 1 khung hình (để làm nhoè chuyển động), y=quãng trôi của mây (giây × tốc độ mây)
uniform vec4 uProps[4];// cỏ lăn: x, y (chân trên mặt đất), góc lăn, kích thước (0 = không có)

out vec4 o;

const float RW = 1.0;      // nửa bề rộng mặt đường (đơn vị thế giới)
const float ZN = 3.0;      // độ sâu ứng với mép dưới khung cảnh
const float WRAP = 660.0;  // chu kỳ quấn vòng quãng đường (bội số của mọi chu kỳ hoa văn)

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
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float fieldS(sampler2D t, vec2 p) { return texture(t, (p / uStep + 0.5) / uGrid).r; }
float iconField(vec2 p) { return mix(fieldS(uFA, p), fieldS(uFB, p), uMix); }
float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0));
}
// Hình thang đối xứng: đáy dưới ở y0 (nửa rộng w0), đáy trên ở y1 < y0 (nửa rộng w1)
float sdTrap(vec2 p, float y0, float w0, float y1, float w1) {
  float t = clamp((y0 - p.y) / (y0 - y1), 0.0, 1.0);
  float hw = mix(w0, w1, t);
  float dx = abs(p.x) - hw;
  float dy = max(p.y - y0, y1 - p.y);
  return max(dx * 0.97, dy);
}
// Độ phủ (0..1) của một sóng vuông chu kỳ P, phần "bật" dài on*P, lấy trung bình trên đoạn [a, b]
float sqInt(float x, float P, float on) { return floor(x / P) * on * P + min(fract(x / P) * P, on * P); }
float sqCover(float a, float b, float P, float on) {
  float w = max(b - a, 1e-4);
  return (sqInt(b, P, on) - sqInt(a, P, on)) / w;
}
float cover(float d, float aa) { return clamp(0.5 - d / aa, 0.0, 1.0); }

// ---------------- Bảng màu theo buổi ----------------
// Hoàng hôn (khớp ảnh mẫu) là gốc; ban ngày xanh trong hơn, ban đêm tím than.
struct Pal {
  vec3 skyTop, skyMid, skyLow, sun, halo, cloudT, cloudB;
  vec3 mtnFar, mtnNear, mtnLit, mesa, mesaLit, mesaDark, hill;
  vec3 sand, sandDark, road, roadLine, crack, haze, shrub, shrubLit, trunk, shadow;
  float night, day;
};

Pal palette(float tod) {
  float day = 1.0 - clamp(abs(tod - 0.5) / 0.2, 0.0, 1.0);
  float night = ss(0.83, 0.92, tod);
  Pal g; // hoàng hôn
  g.skyTop = vec3(0.30, 0.52, 0.71);  g.skyMid = vec3(0.64, 0.77, 0.84);  g.skyLow = vec3(0.99, 0.90, 0.74);
  g.sun = vec3(1.0, 0.97, 0.88);      g.halo = vec3(1.0, 0.86, 0.62);
  g.cloudT = vec3(1.0, 0.95, 0.84);   g.cloudB = vec3(0.96, 0.72, 0.52);
  g.mtnFar = vec3(0.70, 0.70, 0.88);  g.mtnNear = vec3(0.56, 0.56, 0.80); g.mtnLit = vec3(0.80, 0.78, 0.92);
  g.mesa = vec3(0.80, 0.42, 0.38);    g.mesaLit = vec3(0.93, 0.60, 0.52); g.mesaDark = vec3(0.60, 0.29, 0.31);
  g.hill = vec3(0.88, 0.58, 0.52);
  g.sand = vec3(0.90, 0.57, 0.37);    g.sandDark = vec3(0.80, 0.47, 0.32);
  g.road = vec3(0.93, 0.62, 0.43);    g.roadLine = vec3(0.99, 0.95, 0.88); g.crack = vec3(0.62, 0.34, 0.26);
  g.haze = vec3(0.95, 0.74, 0.64);
  g.shrub = vec3(0.39, 0.47, 0.46);   g.shrubLit = vec3(0.60, 0.68, 0.63);
  g.trunk = vec3(0.40, 0.22, 0.20);   g.shadow = vec3(0.42, 0.22, 0.26);

  Pal d; // trưa nắng
  d.skyTop = vec3(0.22, 0.48, 0.78);  d.skyMid = vec3(0.50, 0.72, 0.90);  d.skyLow = vec3(0.86, 0.91, 0.93);
  d.sun = vec3(1.0, 0.99, 0.95);      d.halo = vec3(1.0, 0.96, 0.84);
  d.cloudT = vec3(1.0, 1.0, 1.0);     d.cloudB = vec3(0.82, 0.86, 0.93);
  d.mtnFar = vec3(0.66, 0.72, 0.88);  d.mtnNear = vec3(0.52, 0.58, 0.80); d.mtnLit = vec3(0.78, 0.82, 0.94);
  d.mesa = vec3(0.84, 0.45, 0.33);    d.mesaLit = vec3(0.95, 0.63, 0.47); d.mesaDark = vec3(0.62, 0.30, 0.27);
  d.hill = vec3(0.90, 0.62, 0.48);
  d.sand = vec3(0.93, 0.64, 0.42);    d.sandDark = vec3(0.84, 0.53, 0.35);
  d.road = vec3(0.95, 0.70, 0.50);    d.roadLine = vec3(1.0, 0.98, 0.94);  d.crack = vec3(0.66, 0.38, 0.27);
  d.haze = vec3(0.90, 0.82, 0.76);
  d.shrub = vec3(0.40, 0.50, 0.44);   d.shrubLit = vec3(0.62, 0.72, 0.60);
  d.trunk = vec3(0.42, 0.25, 0.20);   d.shadow = vec3(0.48, 0.28, 0.26);

  Pal n; // đêm sao
  n.skyTop = vec3(0.04, 0.06, 0.16);  n.skyMid = vec3(0.10, 0.11, 0.26);  n.skyLow = vec3(0.30, 0.20, 0.36);
  n.sun = vec3(0.95, 0.96, 1.0);      n.halo = vec3(0.50, 0.58, 0.90);
  n.cloudT = vec3(0.30, 0.30, 0.46);  n.cloudB = vec3(0.18, 0.16, 0.30);
  n.mtnFar = vec3(0.20, 0.19, 0.36);  n.mtnNear = vec3(0.15, 0.14, 0.30); n.mtnLit = vec3(0.28, 0.27, 0.46);
  n.mesa = vec3(0.30, 0.17, 0.25);    n.mesaLit = vec3(0.40, 0.25, 0.36); n.mesaDark = vec3(0.19, 0.11, 0.19);
  n.hill = vec3(0.30, 0.20, 0.30);
  n.sand = vec3(0.30, 0.20, 0.26);    n.sandDark = vec3(0.24, 0.16, 0.22);
  n.road = vec3(0.34, 0.24, 0.30);    n.roadLine = vec3(0.92, 0.86, 0.62); n.crack = vec3(0.16, 0.10, 0.15);
  n.haze = vec3(0.30, 0.22, 0.36);
  n.shrub = vec3(0.16, 0.19, 0.24);   n.shrubLit = vec3(0.24, 0.28, 0.34);
  n.trunk = vec3(0.14, 0.09, 0.13);   n.shadow = vec3(0.10, 0.07, 0.12);

  Pal r;
  #define BL(f) r.f = mix(mix(g.f, d.f, day), n.f, night)
  BL(skyTop); BL(skyMid); BL(skyLow); BL(sun); BL(halo); BL(cloudT); BL(cloudB);
  BL(mtnFar); BL(mtnNear); BL(mtnLit); BL(mesa); BL(mesaLit); BL(mesaDark); BL(hill);
  BL(sand); BL(sandDark); BL(road); BL(roadLine); BL(crack); BL(haze); BL(shrub); BL(shrubLit); BL(trunk); BL(shadow);
  #undef BL
  r.night = night; r.day = day;
  return r;
}

// ---------------- Bầu trời ----------------
float cloudSDF(vec2 p, vec2 c, float k, float seed) {
  vec2 q = (p - c) / k;
  if (abs(q.x) > 190.0 || abs(q.y) > 60.0) return 1e3;
  float d = 1e3;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float h = hash1(seed * 13.0 + fi * 3.7);
    float len = 40.0 + 70.0 * h;
    float rad = 7.0 + 9.0 * hash1(seed * 5.0 + fi * 1.9);
    vec2 o = vec2((fi - 2.0) * 34.0 + (h - 0.5) * 40.0, -rad * 0.6 - fi * 1.5 + 6.0);
    d = min(d, sdSeg(q, o - vec2(len * 0.5, 0.0), o + vec2(len * 0.5, 0.0)) - rad);
  }
  d = max(d, q.y - 7.0);      // đáy mây phẳng
  return d * k;
}

vec3 drawCloud(vec3 col, vec2 p, vec2 c, float k, float seed, Pal P, float s) {
  float d = cloudSDF(p, c, k, seed);
  if (d > 2.0 * s) return col;
  float q = (p.y - c.y) / k;
  vec3 cc = mix(P.cloudT, P.cloudB, ss(-4.0, 2.0, q));
  cc = mix(cc, P.cloudB * 0.94, step(4.5, q));                   // vạt dưới đậm hơn
  return mix(col, cc, cover(d, 1.2 * s) * 0.97);
}

vec3 sky(vec2 p, float W, float hz, float s, Pal P, out float sunMask) {
  float ny = clamp(p.y / hz, 0.0, 1.0);
  vec3 col = mix(P.skyTop, P.skyMid, ss(0.0, 0.62, ny));
  col = mix(col, P.skyLow, ss(0.45, 1.0, ny));

  // Mặt trời to ở chân trời bên trái (ban ngày lên cao hơn, ban đêm thành trăng)
  vec2 sunC = vec2(W * 0.30, mix(hz - 34.0 * s, hz * 0.42, P.day));
  sunC = mix(sunC, vec2(W * 0.30, hz * 0.36), P.night);
  float sunR = mix(mix(46.0, 34.0, P.day), 26.0, P.night) * s;
  float dS = length(p - sunC);
  col = mix(col, P.halo, exp(-max(dS - sunR, 0.0) / (55.0 * s)) * mix(0.38, 0.30, P.night));
  col = mix(col, P.halo, ss(hz * 0.55, hz, p.y) * 0.14 * (1.0 - P.night));
  sunMask = cover(dS - sunR, 1.2 * s);
  col = mix(col, P.sun, sunMask);

  // Sao
  if (P.night > 0.02) {
    vec2 cell = floor(p / (22.0 * s));
    float h = hash2(cell + 17.0);
    if (h > 0.84) {
      vec2 sp = (cell + 0.2 + 0.6 * vec2(hash2(cell + 3.1), hash2(cell + 9.7))) * 22.0 * s;
      float tw = 0.65 + 0.35 * sin(uTime * (1.2 + h * 1.5) + h * 40.0);
      float st = cover(length(p - sp) - 0.9 * s * (0.6 + h), 1.0 * s) * tw;
      col += vec3(0.9, 0.92, 1.0) * st * P.night * (1.0 - ss(hz * 0.6, hz, p.y));
    }
  }

  // Mây dẹt trôi chậm; tốc độ chỉnh được trong Cài đặt (cloudSpeed)
  float span = W + 520.0 * s;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float x0 = hash1(fi * 7.3 + 1.0) * span;
    float spd = (3.0 + 2.5 * hash1(fi * 2.1)) * s;
    float x = mod(x0 + uDrive.y * spd, span) - 260.0 * s;
    float y = hz * (0.18 + 0.42 * hash1(fi * 4.9 + 2.0));
    float k = s * (0.8 + 0.6 * hash1(fi * 1.3 + 5.0)) * mix(1.0, 0.75, ss(0.4, 0.6, y / hz));
    col = drawCloud(col, p, vec2(x, y), k, fi + 1.0, P, s);
  }
  return col;
}

// ---------------- Núi xa & khối sa thạch ----------------
// Chiều cao (px) dãy núi tím xa so với chân trời
float farRange(float x, float W, float s) {
  float u = x / s;
  float h = 18.0 + 9.0 * sin(u * 0.011) + 6.0 * sin(u * 0.029 + 1.3);
  // Đỉnh nhọn lởm chởm phía trái (sau mặt trời)
  float tri = 1.0 - abs(fract(u / 92.0 + 0.3) * 2.0 - 1.0);
  float tri2 = 1.0 - abs(fract(u / 41.0) * 2.0 - 1.0);
  float envL = ss(0.0, 0.10, x / W) * (1.0 - ss(0.30, 0.48, x / W));
  h += (tri * tri * 46.0 + tri2 * 12.0) * envL;
  // Cụm tháp đá nhọn ở giữa (bề rộng, chiều cao, đỉnh vát khác nhau)
  float envC = ss(0.48, 0.55, x / W) * (1.0 - ss(0.68, 0.74, x / W));
  float cw = 19.0;
  float cell = floor(u / cw);
  float hc = hash1(cell * 1.7 + 4.0);
  float wc = 0.25 + 0.3 * hash1(cell * 3.3 + 1.0);
  float fx = abs(fract(u / cw) - 0.5) * 2.0;
  float tower = (1.0 - ss(wc, wc + 0.18, fx)) * step(0.3, hc);
  float tipTaper = 1.0 - fx * fx * 0.25;
  float peak = 16.0 + 50.0 * hc * hc * (0.6 + 0.4 * envC);
  h += envC * (tower * peak * tipTaper + 8.0);
  return h * s;
}
float nearRange(float x, float W, float s) {
  float u = x / s;
  float h = 6.0 + 7.0 * sin(u * 0.017 + 2.0) + 4.0 * sin(u * 0.043);
  float tri = 1.0 - abs(fract(u / 64.0 + 0.6) * 2.0 - 1.0);
  float env = ss(0.02, 0.12, x / W) * (1.0 - ss(0.38, 0.52, x / W)) + ss(0.56, 0.64, x / W) * (1.0 - ss(0.70, 0.76, x / W));
  h += tri * tri * 26.0 * env;
  return max(h, 0.0) * s;
}

vec3 horizonLayers(vec3 col, vec2 p, float W, float hz, float s, Pal P) {
  // Lớp núi tím xa
  float hF = farRange(p.x, W, s);
  if (p.y > hz - hF) {
    float slope = farRange(p.x + 2.0 * s, W, s) - farRange(p.x - 2.0 * s, W, s);
    vec3 c = mix(P.mtnFar, P.mtnLit, ss(0.0, 2.0 * s, slope) * 0.8);
    c = mix(c, P.haze, ss(hz - 6.0 * s, hz, p.y) * 0.35);
    col = mix(col, c, cover(hz - hF - p.y, 1.0 * s));
  }
  // Lớp núi tím gần hơn
  float hN = nearRange(p.x, W, s);
  if (p.y > hz - hN) {
    float slope = nearRange(p.x + 2.0 * s, W, s) - nearRange(p.x - 2.0 * s, W, s);
    vec3 c = mix(P.mtnNear, P.mtnLit, ss(0.0, 1.5 * s, slope) * 0.6);
    col = mix(col, c, cover(hz - hN - p.y, 1.0 * s));
  }
  // Mesa đỏ thấp bên trái, đỉnh bằng giật cấp
  float u = p.x / W;
  float top = hz - (u < 0.15 ? 54.0 : (u < 0.25 ? mix(54.0, 34.0, ss(0.15, 0.17, u)) : mix(34.0, -2.0, ss(0.25, 0.36, u)))) * s;
  if (u < 0.37 && p.y > top) {
    vec3 c = P.mesa;
    float lit = ss(3.5 * s, 0.0, p.y - top);
    c = mix(c, P.mesaLit, lit * 0.8);
    c = mix(c, P.mesaDark, step(0.5, fract((p.y - hz) / (9.0 * s))) * 0.12 * ss(top + 6.0 * s, top + 12.0 * s, p.y));
    c = mix(c, P.haze, 0.18);
    col = mix(col, c, cover(top - p.y, 1.0 * s));
  }
  // Đồi thấp hồng nhạt sát chân trời
  float hh = (4.0 + 5.0 * sin(p.x / s * 0.013 + 0.7) + 3.0 * sin(p.x / s * 0.051)) * s;
  if (p.y > hz - hh) col = mix(col, mix(P.hill, P.haze, 0.35), cover(hz - hh - p.y, 1.0 * s));
  return col;
}

// Khối núi sa thạch giật cấp bên phải
vec3 butte(vec3 col, vec2 p, float W, float hz, float s, Pal P) {
  if (p.x < W * 0.56 || p.y > hz + 2.0 * s) return col;
  // Toạ độ chuẩn hoá: gốc ở chân khối núi, đơn vị px*s
  vec2 q = vec2(p.x - W * 0.86, p.y - hz) / s;
  float jag = (vnoise(vec2(q.y * 0.08, 3.0)) - 0.5) * 5.0;
  float dTower = sdTrap(q + vec2(jag * 0.6, 0.0), -40.0, 118.0, -212.0, 96.0);
  float dStep  = sdTrap(q + vec2(jag, 0.0), -10.0, 186.0, -118.0, 150.0);
  float dSkirt = sdTrap(q, 4.0, 270.0, -44.0, 170.0);
  float d = min(min(dTower, dStep), dSkirt);
  if (d > 2.0) return col;

  // Mặt trước: sáng ở mép trái (nắng chiều từ bên trái), vân trầm tích ngang, khe nứt dọc mờ
  vec3 c = P.mesa;
  float leftEdge;
  float yTop;
  if (dTower < 0.5) { leftEdge = q.x + mix(118.0, 96.0, clamp((-40.0 - q.y) / 172.0, 0.0, 1.0)); yTop = -212.0; }
  else if (dStep < 0.5) { leftEdge = q.x + mix(186.0, 150.0, clamp((-10.0 - q.y) / 108.0, 0.0, 1.0)); yTop = -118.0; }
  else { leftEdge = q.x + mix(270.0, 170.0, clamp((4.0 - q.y) / 48.0, 0.0, 1.0)); yTop = -44.0; }
  c = mix(c, P.mesaLit, (1.0 - ss(6.0, 34.0, leftEdge)) * 0.85);
  c = mix(c, P.mesaDark, ss(40.0, 160.0, q.x) * 0.45);
  float band = sin(q.y * 0.19 + vnoise(vec2(q.x * 0.02, q.y * 0.05)) * 2.0);
  c = mix(c, P.mesaDark, ss(0.55, 0.9, band) * 0.22);
  float flute = abs(fract(q.x / 23.0 + vnoise(vec2(q.y * 0.03, 1.0)) * 0.6) - 0.5);
  c = mix(c, P.mesaDark, ss(0.06, 0.0, flute) * 0.18 * ss(yTop + 8.0, yTop + 30.0, q.y));
  // Gờ đỉnh bằng phẳng đón nắng
  c = mix(c, P.mesaLit, ss(5.0, 0.0, q.y - yTop) * 0.9);
  // Chân núi tan vào hơi nóng
  c = mix(c, P.haze, ss(-60.0, 4.0, q.y) * 0.32);
  c = mix(c, P.haze, 0.08);
  return mix(col, c, cover(d * s, 1.0 * s));
}

// ---------------- Mặt đất & con đường ----------------
vec3 groundAt(float X, float Zw, float z, float fpX, float fpZ, float blur, Pal P) {
  // Cát: mảng loang sẫm thấp tần (không cần làm nhoè vì biến đổi chậm)
  float n1 = vnoise(vec2(X * 0.45, Zw * 0.30) + 11.0);
  float n2 = vnoise(vec2(X * 1.3, Zw * 0.9) + 37.0);
  vec3 c = mix(P.sand, P.sandDark, ss(0.55, 0.62, n1 * 0.75 + n2 * 0.25) * 0.75);
  // Sỏi nhỏ lấm tấm
  vec2 g = vec2(X * 2.2, Zw * 1.4);
  vec2 gi = floor(g);
  float hg = hash2(gi + 5.0);
  vec2 gp = fract(g) - 0.5 - (vec2(hash2(gi + 1.0), hash2(gi + 2.0)) - 0.5) * 0.6;
  float pebble = length(gp * vec2(1.0, 1.6)) - 0.07;
  c = mix(c, P.sandDark * 0.92, cover(pebble, max(fpX * 2.2, 0.02)) * step(0.72, hg) * (1.0 - ss(6.0, 14.0, z)));

  float ax = abs(X);
  if (ax < RW + 0.08) {
    vec3 r = P.road;
    // Mép đường lởm chởm sẫm màu
    float edgeN = (vnoise(vec2(Zw * 3.0, X > 0.0 ? 1.0 : 7.0)) - 0.5) * 0.06;
    float roadMask = cover(ax - RW - edgeN, max(fpX, 0.004) * 1.2);
    float edgeBand = cover(abs(ax - (RW - 0.035) - edgeN) - 0.03, max(fpX, 0.004));
    r = mix(r, P.crack, edgeBand * 0.55);
    // Gạch nứt ở tiền cảnh (đường chỉ ngang được lọc theo quãng chạy của khung hình)
    float vis = 1.0 - ss(5.0, 10.0, z);
    if (vis > 0.0) {
      float L = 0.55;
      float row = floor(Zw / L);
      float lw = 0.016;
      float zA = Zw - (fpZ * 0.5 + blur), zB = Zw + fpZ * 0.5;
      float hLine = sqCover(zA + lw, zB + lw, L, 2.0 * lw / L);
      float off = hash1(mod(row, 1200.0)) * 0.5;
      float cw = 0.5;
      float xl = fract((X + off) / cw);
      float vLine = cover((0.5 - abs(xl - 0.5)) * cw - lw, max(fpX, 0.002));
      float cid = floor((X + off) / cw);
      float crack = max(hLine * step(0.45, hash1(mod(row, 1200.0) * 3.1 + cid)), vLine * step(0.6, hash2(vec2(mod(row, 1200.0), cid))));
      r = mix(r, P.crack, crack * 0.42 * vis);
    }
    // Vạch tim đường đứt khúc
    float dashW = 0.03;
    float lat = cover(ax - dashW, max(fpX, 0.003) * 1.2);
    float zA = Zw - (fpZ * 0.5 + blur), zB = Zw + fpZ * 0.5;
    float dash = sqCover(zA, zB, 3.3, 0.42);
    r = mix(r, P.roadLine, lat * dash);
    c = mix(c, r, roadMask);
  }
  // Hơi nóng xa xăm: tan dần vào màu khói chân trời
  c = mix(c, P.haze, ss(10.0, 90.0, z) * 0.85);
  return c;
}

// ---------------- Vật thể ven đường (bụi cây, đá, cây Joshua) ----------------
// type: 0 bụi cây, 1 đá, 2 cây Joshua, 3 bụi gai nhỏ
void drawObject(inout vec3 col, vec2 p, vec2 base, float m, float type, float h, Pal P, float fog) {
  vec2 q = (p - base) / m;               // đơn vị thế giới, y âm hướng lên
  float aa = 1.0 / m;
  vec3 tint = P.haze;
  if (type < 0.5) {
    float w = 0.28 + 0.28 * h;
    if (abs(q.x - 0.15) > w + 0.5 || q.y < -0.6 || q.y > 0.12) return;
    // Bóng đổ sang phải
    float dsh = length((q - vec2(w * 0.7, 0.02)) / vec2(w * 1.25, 0.06)) - 1.0;
    col = mix(col, col * mix(vec3(1.0), P.shadow * 1.6, 0.55), cover(dsh * 0.06, aa) * (1.0 - fog));
    // Bụi xám xanh: các múi lá nhọn
    float a = atan(q.y + 0.02, q.x);
    float r = length((q + vec2(0.0, 0.02)) / vec2(w, w * 0.62));
    float spikes = 0.82 + 0.18 * abs(sin(a * (7.0 + floor(h * 4.0))));
    float d = (r - spikes) * w * 0.62;
    d = max(d, q.y - 0.02);
    if (d < aa) {
      vec3 c = mix(P.shrub, P.shrubLit, ss(0.0, -0.22 - h * 0.1, q.y) * ss(w * 0.6, -w * 0.4, q.x));
      float leaf = abs(sin(a * 9.0 + h * 9.0));
      c = mix(c, P.shrub * 0.86, ss(0.85, 1.0, leaf) * 0.5);
      col = mix(col, mix(c, tint, fog), cover(d, aa));
    }
  } else if (type < 1.5) {
    float w = 0.16 + 0.22 * h;
    if (abs(q.x) > w * 2.5 || q.y < -w || q.y > 0.1) return;
    float dsh = length((q - vec2(w * 0.8, 0.02)) / vec2(w * 1.4, 0.05)) - 1.0;
    col = mix(col, col * mix(vec3(1.0), P.shadow * 1.6, 0.55), cover(dsh * 0.05, aa) * (1.0 - fog));
    float d = length((q + vec2(0.0, w * 0.15)) / vec2(w, w * 0.62)) - 1.0;
    d = max(d * w * 0.62, q.y - 0.01);
    if (d < aa) {
      vec3 c = mix(P.sandDark * 0.92, mix(P.sand, vec3(1.0, 0.86, 0.72), 0.35), ss(-0.05, -w * 0.5, q.y) * ss(w * 0.5, -w * 0.5, q.x));
      col = mix(col, mix(c, tint, fog), cover(d, aa));
    }
  } else if (type < 2.5) {
    float H = 1.6 + 1.2 * h;
    if (abs(q.x) > 0.9 || q.y < -H - 0.5 || q.y > 0.1) return;
    float lean = (h - 0.5) * 0.25;
    vec2 t0 = vec2(0.0, 0.0), t1 = vec2(lean, -H * 0.62);
    float dT = sdSeg(q, t0, t1) - 0.045 * mix(1.4, 0.8, clamp(-q.y / H, 0.0, 1.0));
    vec2 b1 = t1 + vec2(-0.32, -0.30 - h * 0.2), b2 = t1 + vec2(0.30, -0.42), b3 = t1 + vec2(0.04 * h, -H * 0.38);
    float dB = min(min(sdSeg(q, t1, b1), sdSeg(q, t1 + vec2(0.0, 0.06), b2)), sdSeg(q, t1, b3)) - 0.035;
    float dWood = min(dT, dB);
    float dLeaf = 1e3;
    vec2 tips[3];
    tips[0] = b1; tips[1] = b2; tips[2] = b3;
    for (int i = 0; i < 3; i++) {
      vec2 k = q - tips[i];
      float a = atan(k.y, k.x);
      float rr = 0.15 + 0.06 * abs(sin(a * 6.0 + float(i)));
      dLeaf = min(dLeaf, length(k * vec2(1.0, 1.15)) - rr);
    }
    // Bóng cây đổ dài trên cát
    float dsh = sdSeg(q, vec2(0.0), vec2(H * 0.9, 0.12)) - 0.05;
    col = mix(col, col * mix(vec3(1.0), P.shadow * 1.6, 0.45), cover(dsh, aa) * (1.0 - fog) * step(-0.02, q.y));
    float d = min(dWood, dLeaf);
    if (d < aa) {
      vec3 c = dLeaf < dWood ? mix(P.shrub * 0.7, P.shrubLit * 0.85, ss(0.05, -0.1, q.y - (tips[0].y + tips[1].y) * 0.5) * 0.4) : P.trunk;
      if (dWood <= dLeaf) c = mix(c, P.trunk * 1.5, ss(0.0, -0.03, q.x - lean * clamp(-q.y / H, 0.0, 1.0)) * 0.4);
      col = mix(col, mix(c, tint, fog), cover(d, aa));
    }
  } else {
    float H = 0.35 + 0.25 * h;
    if (abs(q.x) > 0.4 || q.y < -H - 0.1 || q.y > 0.06) return;
    float d = 1e3;
    for (int i = 0; i < 5; i++) {
      float fi = float(i) - 2.0;
      vec2 tip = vec2(fi * 0.09 + (h - 0.5) * 0.05, -H * (1.0 - abs(fi) * 0.18));
      d = min(d, sdSeg(q, vec2(fi * 0.02, 0.0), tip) - 0.018);
    }
    if (d < aa) col = mix(col, mix(mix(P.shrub, P.shrubLit, 0.3), tint, fog), cover(d, aa));
  }
}

// ---------------- Cỏ lăn ----------------
void drawTumbleweed(inout vec3 col, vec2 p, vec4 tw, float s, Pal P) {
  if (tw.w < 0.05) return;
  float r = 15.0 * tw.w * s;
  float bounce = abs(sin(tw.z * 0.5)) * r * 1.1;
  vec2 c = vec2(tw.x, tw.y - r - bounce);
  if (abs(p.x - c.x) > r * 2.5 || p.y < c.y - r * 1.3 || p.y > tw.y + r * 0.4) return;
  // Bóng trên mặt đất co lại khi nảy lên
  float shk = 1.0 - bounce / (r * 1.3) * 0.5;
  float dsh = length((p - vec2(tw.x + r * 0.3, tw.y)) / vec2(r * shk, r * 0.22 * shk)) - 1.0;
  col = mix(col, col * mix(vec3(1.0), P.shadow * 1.6, 0.5), cover(dsh * r * 0.22, 1.0 * s));
  vec2 q = rot(tw.z) * (p - c) / r;
  float l = length(q);
  if (l > 1.08) return;
  // Bó cành rối: vòng ngoài + các cung xoắn bên trong
  float strands = 1e3;
  strands = min(strands, abs(l - 0.90) - 0.07);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    vec2 cc = vec2(cos(fi * 1.7 + 0.4), sin(fi * 2.3 + 1.1)) * (0.25 + 0.06 * fi);
    strands = min(strands, abs(length(q - cc) - (0.42 + 0.07 * fi)) - 0.05);
  }
  // Lõi rối đặc hơn ở giữa
  strands = min(strands, l - 0.30 - 0.08 * sin(atan(q.y, q.x) * 7.0));
  strands = max(strands, l - 0.98);
  vec3 wc = mix(vec3(0.62, 0.44, 0.27), vec3(0.42, 0.28, 0.19), ss(-0.6, 0.8, q.y));
  wc = mix(wc, P.shadow, P.night * 0.6);
  col = mix(col, wc, cover(strands * r, 1.0 * s) * 0.95);
}

// ---------------- Xe thể thao 80s nhìn từ phía sau ----------------
vec3 bodyColor(float idx) {
  if (idx < 0.5) return vec3(0.90, 0.52, 0.58);   // hồng san hô như ảnh mẫu
  if (idx < 1.5) return vec3(0.96, 0.30, 0.62);   // hồng neon
  if (idx < 2.5) return vec3(0.93, 0.92, 0.94);   // trắng ngọc trai
  return vec3(0.17, 0.17, 0.21);                   // đen tuyền
}

vec3 drawCar(vec3 col, vec2 p, vec2 pos, float s, Pal P, float carIdx, float flame, float sigL, float sigR, float tilt, float roadW) {
  vec2 lp = rot(-tilt * 0.06) * (p - pos) / s;
  float aa = 1.1 / s;
  vec3 paint = bodyColor(carIdx);
  vec3 lightTint = mix(vec3(1.0), vec3(1.0, 0.93, 0.88), 1.0 - P.day);
  paint = mix(paint * lightTint, paint * vec3(0.42, 0.40, 0.58), P.night * 0.75);
  vec3 dark = mix(vec3(0.24, 0.21, 0.27), vec3(0.10, 0.09, 0.13), P.night);

  // Ánh đèn hậu hắt xuống mặt đường (đêm / chạng vạng)
  float glowAmt = 0.08 + 0.55 * P.night;
  {
    vec2 g = (lp - vec2(0.0, 30.0)) / vec2(150.0, 46.0);
    col += vec3(0.95, 0.20, 0.16) * exp(-dot(g, g) * 2.0) * glowAmt * 0.55;
  }

  if (abs(lp.x) > 260.0 || lp.y < -150.0 || lp.y > 80.0) return col;

  // Bóng đổ xiên về phía phải-trước
  {
    vec2 q = lp;
    q.x -= (q.y + 2.0) * 1.6;
    float d = sdBox(q - vec2(4.0, 16.0), vec2(96.0, 15.0), 10.0);
    float sh = cover(d, 6.0) * (0.55 - 0.25 * P.night);
    col = mix(col, P.shadow * 0.9, sh * step(-4.0, lp.y));
    float ao = cover(sdBox(lp - vec2(0.0, 2.0), vec2(100.0, 5.0), 5.0), 8.0);
    col = mix(col, P.shadow * 0.6, ao * 0.6);
  }

  // Lửa Nitro phụt về phía camera
  if (flame > 0.02) {
    for (int i = 0; i < 2; i++) {
      float sx = i == 0 ? -34.0 : 34.0;
      vec2 base = vec2(sx, -16.0);
      float fl = flame * (50.0 + 14.0 * vnoise(vec2(uTime * 18.0, sx)));
      vec2 k = lp - base;
      float t = clamp(k.y / fl, 0.0, 1.0);
      float wdt = mix(8.0, 1.5, t) * (0.7 + 0.3 * flame);
      float d = max(abs(k.x + sin(k.y * 0.3 + uTime * 30.0) * 1.2 * t) - wdt, max(-k.y, k.y - fl));
      if (d < 3.0) {
        vec3 fc = mix(vec3(0.75, 0.92, 1.0), vec3(1.0, 0.62, 0.20), ss(0.15, 0.7, t));
        col = mix(col, fc, cover(d, 2.0) * (1.0 - t * 0.6));
      }
    }
  }

  // Lốp xe
  float dTire = min(sdBox(lp - vec2(-70.0, -17.0), vec2(16.0, 17.0), 4.0), sdBox(lp - vec2(70.0, -17.0), vec2(16.0, 17.0), 4.0));
  if (dTire < aa) {
    vec3 tc = vec3(0.13, 0.12, 0.15) * mix(1.0, 0.6, P.night);
    tc = mix(tc, tc * 1.9, step(0.82, fract(lp.y / 6.0)) * 0.25);
    col = mix(col, tc, cover(dTire, aa));
  }

  // Cản dưới & bộ khuếch tán
  float dLow = sdTrap(lp, -10.0, 90.0, -46.0, 96.0);
  if (dLow < aa) {
    vec3 lc = dark;
    lc = mix(lc, dark * 1.6, ss(-40.0, -46.0, lp.y) * 0.8);
    float fin = abs(fract(lp.x / 9.0) - 0.5);
    lc = mix(lc, dark * 0.6, step(abs(lp.x), 44.0) * step(-26.0, lp.y) * ss(0.12, 0.05, fin) * 0.8);
    col = mix(col, lc, cover(dLow, aa));
    // Ống xả kép
    for (int i = 0; i < 2; i++) {
      float sx = i == 0 ? -34.0 : 34.0;
      float de = sdBox(lp - vec2(sx, -17.0), vec2(10.0, 4.6), 4.0);
      vec3 ec = mix(vec3(0.70, 0.70, 0.76), vec3(0.18, 0.16, 0.20), ss(2.5, -1.0, de + 2.5));
      ec = mix(ec, vec3(1.0, 0.7, 0.35), flame * ss(0.0, -3.0, de));
      col = mix(col, ec * mix(1.0, 0.5, P.night), cover(de, aa));
    }
  }

  // Thân xe chính (hình nêm)
  float dBody = sdTrap(lp, -44.0, 100.0, -96.0, 90.0);
  if (dBody < aa) {
    vec3 bc = paint;
    bc = mix(bc, paint * 1.12 + 0.03, ss(-60.0, -96.0, lp.x) * 0.9);      // hông trái đón nắng
    bc = mix(bc, paint * 0.80, ss(55.0, 100.0, lp.x) * 0.8);               // hông phải khuất
    bc = mix(bc, paint * 0.86, ss(-52.0, -44.0, lp.y) * 0.9);             // mép dưới
    bc = mix(bc, paint * 1.18 + 0.04, ss(-91.0, -96.0, lp.y) * 0.9);      // mép trên
    col = mix(col, bc, cover(dBody, aa));
    // Rãnh gân thân xe
    col = mix(col, paint * 0.72, cover(abs(lp.y + 82.0) - 0.8, aa) * step(abs(lp.x), 88.0) * 0.7);
  }

  // Dải đèn hậu ngang
  float dPanel = sdBox(lp - vec2(0.0, -64.0), vec2(88.0, 12.5), 3.0);
  if (dPanel < aa) {
    col = mix(col, dark * 0.85, cover(dPanel, aa));
    for (int i = 0; i < 2; i++) {
      float sx = i == 0 ? -50.0 : 50.0;
      float dl = sdBox(lp - vec2(sx, -64.0), vec2(33.0, 8.5), 2.0);
      if (dl < aa) {
        vec3 lc = vec3(0.92, 0.20, 0.22);
        float louver = step(0.62, fract((lp.y + 64.0) / 3.4));
        lc = mix(lc, vec3(0.55, 0.08, 0.12), louver * 0.6);
        lc = mix(lc, vec3(1.0, 0.55, 0.50), ss(-70.0, -72.5, lp.y) * 0.5);
        bool outer = (i == 0 && lp.x < -62.0) || (i == 1 && lp.x > 62.0);
        float blink = step(0.0, sin(uTime * 9.0));
        if (outer && ((i == 0 && sigL > 0.5) || (i == 1 && sigR > 0.5))) lc = mix(lc, vec3(1.0, 0.72, 0.18), blink);
        lc += vec3(0.25, 0.04, 0.03) * P.night;
        col = mix(col, lc, cover(dl, aa));
      }
    }
    // Ô biển số giữa
    float dp = sdBox(lp - vec2(0.0, -64.0), vec2(13.0, 6.0), 1.5);
    col = mix(col, mix(vec3(0.86, 0.82, 0.84), vec3(0.4, 0.38, 0.45), P.night * 0.8), cover(dp, aa));
  }
  // Quầng sáng đèn hậu ban đêm
  {
    float dl = min(sdBox(lp - vec2(-50.0, -64.0), vec2(33.0, 8.5), 2.0), sdBox(lp - vec2(50.0, -64.0), vec2(33.0, 8.5), 2.0));
    col += vec3(1.0, 0.22, 0.18) * exp(-max(dl, 0.0) / 10.0) * (0.06 + 0.4 * P.night) * step(0.0, dl);
  }

  // Cánh lướt gió nhỏ trên nắp sau
  float dLip = sdBox(lp - vec2(0.0, -97.0), vec2(90.0, 3.2), 2.0);
  if (dLip < aa) col = mix(col, paint * 1.08 + 0.02, cover(dLip, aa));

  // Cabin kính
  float dCab = sdTrap(lp, -98.0, 74.0, -132.0, 54.0);
  if (dCab < aa) {
    col = mix(col, paint * 0.95, cover(dCab, aa));
    float dGlass = sdTrap(lp, -101.0, 64.0, -127.0, 48.0);
    if (dGlass < aa) {
      vec3 gl0 = mix(vec3(0.30, 0.33, 0.46), vec3(0.62, 0.66, 0.78), ss(-101.0, -127.0, lp.y));
      gl0 = mix(gl0, P.skyMid * 0.9, 0.25);
      float refl = abs(fract((lp.x * 0.6 + lp.y) / 46.0) - 0.5);
      gl0 = mix(gl0, gl0 * 1.25 + 0.06, ss(0.12, 0.06, refl) * 0.6);
      gl0 = mix(gl0, vec3(0.06, 0.06, 0.12), P.night * 0.7);
      col = mix(col, gl0, cover(dGlass, aa));
    }
    col = mix(col, paint * 1.15 + 0.04, cover(abs(lp.y + 131.0) - 1.2, aa) * step(abs(lp.x), 54.0) * 0.8);
  }
  // Gương chiếu hậu
  for (int i = 0; i < 2; i++) {
    float sx = i == 0 ? -1.0 : 1.0;
    float dm = min(sdBox(lp - vec2(sx * 84.0, -106.0), vec2(9.0, 5.5), 3.0), sdSeg(lp, vec2(sx * 70.0, -102.0), vec2(sx * 80.0, -105.0)) - 2.0);
    if (dm < aa) col = mix(col, i == 0 ? paint * 1.05 : paint * 0.82, cover(dm, aa));
  }
  return col;
}

// ---------------- Khối đá ôm biểu tượng Desktop ----------------
vec3 iconRock(vec3 col, vec2 p, float hz, float s, Pal P, float dI) {
  // Bóng đổ của khối đá xuống cát bên phải
  if (dI > 0.0 && p.y > hz) {
    float dSh = iconField(p - vec2(16.0, 4.0) * s);
    col = mix(col, col * mix(vec3(1.0), P.shadow * 1.5, 0.6), cover(dSh, 6.0 * s) * 0.8);
  }
  if (dI > 1.5 * s) return col;
  float gx = iconField(p + vec2(3.0, 0.0)) - iconField(p - vec2(3.0, 0.0));
  float gy = iconField(p + vec2(0.0, 3.0)) - iconField(p - vec2(0.0, 3.0));
  // Vách sa thạch như khối núi bên phải: các tầng đá nằm ngang giật cấp, dày mỏng khác nhau
  float ly = p.y / s;
  float lyW = ly + vnoise(vec2(p.x / (80.0 * s), 3.0)) * 10.0;
  float layer = floor(lyW / 34.0);
  float lf = fract(lyW / 34.0);
  float lh = hash1(layer * 2.3 + 1.0);
  vec3 c = mix(P.mesa, mix(P.mesaLit, P.mesa, 0.55), lh * 0.5);
  c = mix(c, P.mesaLit, ss(0.08, 0.0, lf) * 0.45);                // gờ tầng đón nắng
  c = mix(c, P.mesaDark, ss(0.86, 1.0, lf) * 0.22);              // chân tầng khuất bóng
  float flute = abs(fract(p.x / (37.0 * s) + vnoise(vec2(p.y / (120.0 * s), layer)) * 1.2) - 0.5);
  c = mix(c, P.mesaDark, ss(0.04, 0.0, flute) * 0.10);
  // Mép đá: sáng ở mép trái/trên, tối ở mép phải/dưới
  float rim = ss(-22.0 * s, 0.0, dI);
  float face = clamp(gx * 0.3 + gy * 0.15, -1.0, 1.0);
  c = mix(c, face < 0.0 ? P.mesaLit : P.mesaDark, abs(face) * rim * 0.9);
  c = mix(c, P.haze, 0.06);
  return mix(col, c, cover(dI, 1.2 * s));
}

// ---------------- Hàm chính ----------------
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y * uScale - gl_FragCoord.y) / uScale;
  float W = uRes.x, H = uRes.y;
  float availH = max(280.0, H - 48.0);
  float s = min(W / 1280.0, availH / 720.0);
  vec2 v = p + vec2(0.0, uEffects.w * s);

  float hz = availH * 0.47;
  float D0 = availH - hz;
  float G = 340.0 * s / D0;                 // px cho 1 đơn vị thế giới trên mỗi px độ sâu
  float vpX = W * 0.5;
  float dist = uCar.w;
  float blur = uDrive.x;

  Pal P = palette(uScene.x);
  vec3 col;

  if (v.y <= hz) {
    float sunMask;
    col = sky(v, W, hz, s, P, sunMask);
    col = horizonLayers(col, v, W, hz, s, P);
  } else {
    float dy = v.y - hz;
    float z = ZN * D0 / dy;
    float X = (v.x - vpX) / (dy * G);
    float fpX = 1.0 / (dy * G);
    float fpZ = z * z / (ZN * D0);
    col = groundAt(X, z + dist, z, fpX, fpZ, blur, P);
  }
  col = butte(col, v, W, hz, s, P);

  // Vật thể ven đường: duyệt các ô theo độ sâu, từ xa tới gần
  if (v.y > hz - 260.0 * s) {
    const float CZ = 5.5;
    float k0 = floor((dist + 1.2) / CZ);
    for (int i = 13; i >= 0; i--) {
      float k = k0 + float(i);
      float kk = mod(k, 120.0);
      for (int side = 0; side < 2; side++) {
        float sd = side == 0 ? -1.0 : 1.0;
        for (int j = 0; j < 2; j++) {
          float fj = float(j);
          float h = hash1(kk * 1.31 + sd * 7.7 + fj * 3.3 + 0.5);
          float zw = (k + 0.5 * fj + 0.4 * hash1(kk + fj * 9.1 + sd)) * CZ;
          float z = zw - dist;
          if (z < 1.0 || z > 80.0) continue;
          float h2 = hash1(kk * 2.7 + sd * 3.1 + fj * 5.9);
          float X = sd * (RW + 0.55 + h2 * h2 * 9.0);
          float type = h < 0.52 ? 0.0 : (h < 0.70 ? 1.0 : (h < 0.84 ? 3.0 : 2.0));
          if (type > 1.5 && type < 2.5 && abs(X) < RW + 2.0) type = 0.0;
          float dyO = ZN * D0 / z;
          float m = dyO * G;
          if (m < 3.0) continue;
          vec2 base = vec2(vpX + X * m, hz + dyO);
          if (v.y > base.y + 0.2 * m || v.y < base.y - 3.4 * m) continue;
          float fog = ss(10.0, 90.0, z) * 0.85;
          drawObject(col, v, base, m, type, hash1(kk * 4.3 + fj + sd), P, fog);
        }
      }
    }
  }

  // Khối đá ôm biểu tượng
  float dI = iconField(v);
  if (dI < 30.0 * s) col = iconRock(col, v, hz, s, P, dI);

  // Cỏ lăn
  for (int t = 0; t < 4; t++) drawTumbleweed(col, v, uProps[t], s, P);

  // Xe
  float carDy = 0.56 * D0;
  float roadHalfAtCar = carDy * G * RW;
  vec2 carPos = vec2(vpX + uCar.x * 0.55 * roadHalfAtCar, hz + carDy + uCar.y * s);
  col = drawCar(col, v, carPos, s, P, uScene.w, uEffects.x, uEffects.y, uEffects.z, uCar.z, roadHalfAtCar);

  // Hạt nhiễu cực nhẹ chống vệt dải màu
  col += (hash2(p + fract(uSeed) * 100.0) - 0.5) / 255.0;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}
