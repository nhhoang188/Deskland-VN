#version 300 es
// Deskland · Ruộng bậc thang lên đèn (Terrace Lights)
// Dùng chung cho cả prototype/terrace-lights.html (WebGL2) và deskland-rs (OpenGL 3.3).
// Giờ xanh chạng vạng trên vùng núi cao: những sườn nương chè / ruộng bậc thang uốn lượn 3D
// với hàng nghìn đốm đèn vàng ấm chạy dọc bờ, cụm bản làng cổ nép mình dưới thung lũng mờ sương,
// khóm tre rặng cây rìa đồi, biển mây xanh coban bồng bềnh tán xạ ánh đèn bản làng
// và các dãy núi hùng vĩ mờ sương phía xa.

precision highp float;

uniform sampler2D uNoise, uFA, uFB;
uniform vec2 uRes, uGrid;
uniform float uScale, uSeed, uStep, uMix, uTime, uDebug;

uniform vec4 uScene;     // x=mật độ đèn (0..1), y=lượng mây (0..1), z=độ sáng trời chạng vạng (0..1), w=0
uniform vec4 uFog;       // x=quãng trôi của mây (px ở s=1), y=gió giật (0..1), z,w=0
uniform vec4 uWave[2];   // sóng đèn bừng sáng: x,y tâm; z=tuổi (giây, <-50 = không có)
uniform vec4 uLant[4];   // đèn trời: x,y điểm thả; z=tuổi (giây, <-50 = không có); w=hạt giống

out vec4 o;

// ---------------- Hàm cơ sở & Nhiễu phần cứng ----------------
float hash1(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
float hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
             mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec4 texN(vec2 p, float periodPx) {
  return texture(uNoise, p / periodPx + uSeed * 0.13);
}
// Mây mượt dùng kênh B ([8,16,32] không quá gắt) kết hợp kênh R
float smoothCloudNoise(vec2 p, float s) {
  float b1 = texN(p, 920.0 * s).b;
  float r1 = texN(p * 1.45 + vec2(43.0, 19.0), 760.0 * s).r;
  return b1 * 0.68 + r1 * 0.32;
}
float ss(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float cover(float d, float aa) { return clamp(0.5 - d / max(aa, 1e-4), 0.0, 1.0); }
float fieldS(sampler2D t, vec2 p) { return texture(t, (p / uStep + 0.5) / uGrid).r; }
float iconField(vec2 p) { return mix(fieldS(uFA, p), fieldS(uFB, p), uMix); }

const vec3 LAMP = vec3(1.00, 0.86, 0.52);
const vec3 LAMP_GLOW = vec3(1.00, 0.60, 0.22);
const vec3 WIN = vec3(1.00, 0.72, 0.32);

// Bảng màu sương mù giờ xanh êm sáng bồng bềnh (Cobalt-Periwinkle Blue Mist như 2 ảnh mẫu)
vec3 mistDeepCol(float dusk) {
  return mix(vec3(0.085, 0.18, 0.34), vec3(0.22, 0.40, 0.68), dusk);
}
vec3 mistLightCol(float dusk) {
  return mix(vec3(0.25, 0.42, 0.68), vec3(0.64, 0.80, 0.98), dusk);
}

// Đường sống đồi tiền cảnh (khớp 1:1 với hit-test bên Rust và JS)
float fgRidgeY(float x, float W, float A, float s) {
  float nx = x / W;
  float base = A * (0.395 + 0.275 * ss(0.0, 1.0, nx * 0.92 + 0.04));
  float spur = -sin(nx * 5.2 + 0.4) * 14.0 * s + cos(nx * 10.5 - 0.8) * 4.5 * s;
  return base + spur;
}

// ---------------- 1. Bầu trời Giờ xanh ----------------
vec3 sky(vec2 p, float W, float A, float s, float dusk, float drift) {
  float ny = clamp(p.y / (0.28 * A), 0.0, 1.0);
  vec3 top = mix(vec3(0.025, 0.06, 0.15), vec3(0.09, 0.21, 0.42), dusk);
  vec3 mid = mix(vec3(0.08, 0.17, 0.33), vec3(0.26, 0.45, 0.72), dusk);
  vec3 low = mix(vec3(0.16, 0.28, 0.46), vec3(0.46, 0.66, 0.90), dusk);
  vec3 col = ny < 0.5 ? mix(top, mid, ny * 2.0) : mix(mid, low, (ny - 0.5) * 2.0);

  // Dải mây cao mềm mượt trên đỉnh trời
  vec2 cq = vec2(p.x + drift * 0.30 * s, p.y * 2.8);
  float c = smoothCloudNoise(cq, s);
  vec3 hiCloud = mix(vec3(0.20, 0.34, 0.56), vec3(0.64, 0.80, 0.98), dusk);
  col = mix(col, hiCloud, ss(0.46, 0.82, c) * (1.0 - ss(0.35, 1.0, ny)) * 0.42);

  // Vài ngôi sao mảnh khi dusk thấp
  float starVis = clamp(1.0 - dusk * 0.92, 0.0, 1.0);
  if (starVis > 0.05 && ny < 0.65) {
    vec2 g = floor(p / (24.0 * s));
    float h = hash2(g + 5.0);
    if (h > 0.945) {
      vec2 sp = (g + 0.25 + 0.5 * vec2(hash2(g + 1.1), hash2(g + 2.3))) * 24.0 * s;
      float tw = 0.6 + 0.4 * sin(uTime * (0.9 + h * 2.1) + h * 40.0);
      col += vec3(0.88, 0.93, 1.0) * cover(length(p - sp) - 0.65 * s, 0.9 * s) * tw * starVis * (1.0 - ny / 0.65);
    }
  }
  return col;
}

// ---------------- 2. Rặng núi hùng vĩ & Sông mây kẽ núi ----------------
float mountainTop(float x, float W, float A, float s, int layer) {
  float nx = x / W;
  if (layer == 0) {
    // Dãy núi xa nhất với sống núi uốn lượn gồ ghề tự nhiên (không bị đường cung sin trơn nhẵn)
    float broad = sin(nx * 2.5 + 0.4) * 0.022 + cos(nx * 5.6 - 0.8) * 0.014;
    float peaks = (texN(vec2(x * 0.45, 17.0 * s), 780.0 * s).r - 0.5) * 0.055;
    float fine = (texN(vec2(x * 1.4, 53.0 * s), 520.0 * s).a - 0.5) * 0.015;
    return A * (0.088 + broad + peaks + fine);
  } else if (layer == 1) {
    float slope = 0.032 * ss(0.10, 0.72, nx) + 0.022 * ss(0.55, 0.98, nx);
    float ridge = -0.040 * exp(-pow((nx - 0.36) / 0.16, 2.0)) - 0.032 * exp(-pow((nx - 0.76) / 0.18, 2.0));
    float macro = (texN(vec2(x * 0.38, 77.0 * s), 860.0 * s).g - 0.5) * 0.036;
    float canopy = (texN(vec2(x * 1.2, 121.0 * s), 520.0 * s).a - 0.5) * 0.010;
    return A * (0.128 + slope + ridge + macro + canopy);
  } else {
    float rightDrop = 0.055 + 0.19 * ss(0.38, 0.95, nx);
    float saddle = -0.036 * exp(-pow((nx - 0.56) / 0.14, 2.0));
    float canopy = (texN(vec2(x * 1.4, 211.0 * s), 460.0 * s).a - 0.5) * 0.010;
    return A * (0.136 + rightDrop + saddle + canopy);
  }
}

vec3 drawMountainsAndValleyBasin(vec3 col, vec2 p, float W, float A, float s, float dusk, float fogAmt, float drift) {
  vec3 mDeep = mistDeepCol(dusk);
  vec3 mLight = mistLightCol(dusk);
  float nx = p.x / W;

  for (int i = 0; i < 3; i++) {
    float top = mountainTop(p.x, W, A, s, i);
    if (p.y >= top - 2.0 * s) {
      float fi = float(i);
      vec3 rock = mix(vec3(0.05, 0.12, 0.24), vec3(0.12, 0.26, 0.46), dusk);
      if (i == 2) {
        // Sườn núi & lòng thung lũng tối thẫm làm nền đất chắc chắn
        rock = mix(vec3(0.025, 0.068, 0.105), vec3(0.055, 0.14, 0.21), dusk);
      } else {
        rock *= (1.0 - fi * 0.14);
      }

      float fol = texN(p * vec2(1.1, 1.7) + fi * 23.0 * s, 280.0 * s).a;
      rock *= 0.90 + 0.18 * fol;

      float dInto = p.y - top;
      float fogStrength = (i < 2) ? (0.48 - fi * 0.08) : (0.24 * ss(0.45, 0.95, nx));
      float valleyFog = ss(14.0 * s, 100.0 * s, dInto) * fogStrength;
      rock = mix(rock, mix(mDeep, mLight, 0.45), valleyFog);
      col = mix(col, rock, cover(top - p.y, 1.8 * s));
    }

    // Dòng mây mềm mượt trôi luồn qua kẽ núi phía sau
    if (i < 2) {
      float ny = p.y / A;
      float band = ss(0.04 + float(i) * 0.04, 0.12 + float(i) * 0.05, ny)
                 * (1.0 - ss(0.20 + float(i) * 0.06, 0.33 + float(i) * 0.07, ny));
      if (band > 0.01) {
        vec2 mq = vec2(p.x + drift * (0.55 + float(i) * 0.35) * s, p.y * 2.2) + float(i) * 140.0 * s;
        vec2 warp = texN(mq * 0.32, 920.0 * s).bg - 0.5;
        float dn = smoothCloudNoise(mq + warp * 150.0 * s, s);
        float dens = ss(0.42 - fogAmt * 0.18, 0.78 - fogAmt * 0.14, dn) * band * mix(0.42, 0.92, fogAmt);
        vec3 mc = mix(mDeep, mLight, ss(0.26, 0.74, dn));
        col = mix(col, mc, dens * (0.56 + 0.34 * ss(0.22, 0.85, nx)));
      }
    }
  }
  return col;
}

// ---------------- 3. Trường pha bậc thang 3D mượt ----------------
float fgPotential(vec2 p, float W, float A, float s, float ridgeY) {
  float nx = p.x / W;
  float dy = max(p.y - ridgeY + 24.0 * s, 2.0 * s);
  float arch = sin(nx * 3.8 + 0.35) * 1.1 - nx * 1.15;
  float flow = (texN(vec2(p.x * 0.7, p.y * 0.25), 960.0 * s).b - 0.5) * 0.52 * ss(18.0 * s, 140.0 * s, dy);
  float logScale = 7.2 + 1.6 * ss(0.35, 0.95, nx);
  return logScale * log(dy / s) + arch + flow;
}

float midPotential(vec2 p, float W, float A, float s, float ridgePeak) {
  float nx = p.x / W;
  float dy = max(p.y - ridgePeak + 16.0 * s, 2.0 * s);
  float arch = sin(nx * 10.5 - 0.5) * 0.85 + cos(nx * 5.2 + 1.1) * 0.65;
  float flow = (texN(vec2(p.x * 0.9, p.y * 0.3), 760.0 * s).g - 0.5) * 0.42 * ss(12.0 * s, 90.0 * s, dy);
  return 10.8 * log(dy / s) + arch + flow;
}

// Lưới hàng xóm 3x3 + Euclidean Taylor offset -> đốm sáng tròn êm, không cắt cạnh ô
vec3 terraceLamps3x3(vec3 baseCol, vec2 p, float T, vec2 gradT, float lights, float s, float isFg) {
  if (lights < 0.01) return baseCol;
  float gLen = max(length(gradT), 1e-4);
  float ppt = 1.0 / gLen;
  float pptFade = ss(1.6 * s, 4.2 * s, ppt);
  if (pptFade < 0.02) return baseCol;

  float phaseShift = mix(0.12, 0.86, isFg);
  float baseNl = floor(T + (1.0 - phaseShift) + 0.5);
  float minStep = mix(12.5 * s, 25.0 * s, isFg);
  float dTdy = max(gradT.y, 0.002);

  vec3 totalLight = vec3(0.0);
  float seedInt = floor(uSeed * 100.0);

  for (int dn = -1; dn <= 1; dn++) {
    float nl = baseNl + float(dn);
    float rowId = mod(nl, 512.0);
    float rowScale = exp(nl / mix(10.8, 7.2, isFg));
    float sx = max(rowScale * mix(0.24, 0.44, isFg) * s, minStep);
    float baseCi = floor(p.x / sx);
    float tTarget = nl - 1.0 + phaseShift;

    for (int dc = -1; dc <= 1; dc++) {
      float ci = baseCi + float(dc);
      float h = hash2(vec2(rowId * 1.9 + isFg * 37.0, ci) + seedInt);
      float dens = lights * mix(0.56, 0.70, isFg);
      if (h >= dens) continue;

      float hSz = hash2(vec2(ci * 1.7 + 11.0, rowId));
      float xCenter = (ci + 0.16 + 0.68 * hash2(vec2(ci + 3.1, rowId))) * sx;
      float jy = (hash2(vec2(rowId, ci * 2.7)) - 0.5) * min(ppt * 0.10, 1.4 * s);

      float dx = p.x - xCenter;
      float dy = (T - tTarget - gradT.x * dx) / dTdy - jy;
      float d = length(vec2(dx, dy));

      float rBase = mix(clamp(ppt * 0.044, 0.6 * s, 1.3 * s), clamp(ppt * 0.048, 0.85 * s, 2.0 * s), isFg);
      float r = rBase * (0.78 + 0.44 * hSz);
      if (d > r * 14.0 + 18.0 * s) continue;

      float tw = 0.74 + 0.26 * sin(uTime * (0.7 + 1.5 * hash1(h * 97.0)) + h * 70.0);

      float boost = 0.0;
      if (isFg > 0.5) {
        vec2 lampPos = p - vec2(dx, dy);
        for (int wi = 0; wi < 2; wi++) {
          vec4 wv = uWave[wi];
          if (wv.z < -50.0) continue;
          float rr = wv.z * 380.0 * s;
          float dw = length(lampPos - wv.xy);
          float ring = exp(-pow((dw - rr) / (58.0 * s), 2.0)) * exp(-wv.z * 0.85);
          float pool = exp(-dw / (220.0 * s)) * exp(-wv.z * 0.65);
          boost += ring * 2.1 + pool * 0.6;
        }
      }

      float lum = tw * (1.0 + boost) * pptFade;
      float core = cover(d - r, 0.95 * s);
      float halo = exp(-d / (r * 3.1 + 2.4 * s));
      float bounce = exp(-d / (r * 6.5 + 9.0 * s)) * isFg * (0.085 + 0.11 * boost);

      totalLight += LAMP_GLOW * bounce * pptFade + LAMP * core * 1.05 * lum + LAMP_GLOW * halo * 0.38 * lum;
    }
  }
  return baseCol + totalLight;
}

vec3 drawMidTerraces(vec3 col, vec2 p, float W, float A, float s, float lights, float dusk, float fogAmt) {
  float nx = p.x / W;
  // Mờ dần mượt vào thung lũng trước ranh giới 0.68 -> HẾT SẠCH VẾT CẮT ĐỨNG Ở GIỮA!
  float fadeX = 1.0 - ss(0.46, 0.67, nx);
  if (fadeX < 0.005) return col;

  float ridgePeak = A * (0.145 + 0.33 * ss(0.06, 0.58, nx) - 0.025 * exp(-pow((nx - 0.24) / 0.14, 2.0)));
  float canopyH = (texN(vec2(p.x * 1.5, 44.0 * s), 420.0 * s).a - 0.5) * 7.0 * s;
  float topMid = ridgePeak + canopyH;
  if (p.y < topMid - 2.0 * s) return col;

  float dFromTop = p.y - topMid;
  float terrMask = ss(10.0 * s, 38.0 * s, dFromTop) * (1.0 - ss(0.42, 0.60, nx));
  float gullyNoise = texN(p * vec2(0.65, 1.0), 580.0 * s).r;
  terrMask *= ss(0.22, 0.44, gullyNoise);

  float eps = 1.5 * s;
  float T = midPotential(p, W, A, s, ridgePeak);
  float dTdx = (midPotential(p + vec2(eps, 0.0), W, A, s, ridgePeak) - midPotential(p - vec2(eps, 0.0), W, A, s, ridgePeak)) / (2.0 * eps);
  float dTdy = (midPotential(p + vec2(0.0, eps), W, A, s, ridgePeak) - midPotential(p - vec2(0.0, eps), W, A, s, ridgePeak)) / (2.0 * eps);
  vec2 gradT = vec2(dTdx, dTdy);

  float bush = texN(p * vec2(1.8, 2.5), 150.0 * s).a;
  vec3 forestC = mix(vec3(0.025, 0.075, 0.075), vec3(0.055, 0.14, 0.13), dusk) * (0.82 + 0.36 * bush);

  float f = fract(T);
  float cushion = sin(ss(0.0, 0.90, f) * 3.14159);
  vec3 terrC = mix(vec3(0.035, 0.10, 0.08), vec3(0.105, 0.255, 0.14), cushion) * (0.86 + 0.24 * bush) * mix(0.75, 1.12, dusk);
  float shoulder = ss(0.55, 0.85, f) * (1.0 - ss(0.85, 1.0, f));
  terrC = mix(terrC, mistLightCol(dusk) * 0.45, shoulder * (0.28 + 0.22 * dusk));

  vec3 hill = mix(forestC, terrC, terrMask);
  vec3 mBase = mix(mistDeepCol(dusk), mistLightCol(dusk), 0.38);
  float distFog = ss(0.20, 0.62, nx) * (0.32 + 0.20 * fogAmt);
  hill = mix(hill, mBase, distFog);

  hill = terraceLamps3x3(hill, p, T, gradT, lights * terrMask * (1.0 - distFog * 0.45), s, 0.0);
  return mix(col, hill, cover(topMid - p.y, 1.6 * s) * fadeX);
}

// ---------------- 4. Bản làng ẩn hiện trong hõm thung lũng (Không trôi trên mây bên phải) ----------------
vec3 drawVillage(vec3 col, vec2 p, float W, float A, float s, float dusk, float lights, out float outVillageWarmth) {
  outVillageWarmth = 0.0;
  float nx = p.x / W;
  float ny = p.y / A;

  // Bản làng tụ quần nương theo thung lũng chữ V trung-trái (nx = 0.20 .. 0.65)
  float envX = ss(0.19, 0.29, nx) * (1.0 - ss(0.54, 0.68, nx));
  float centerSlope = A * (0.370 + 0.145 * ss(0.20, 0.70, nx));
  float bandY = 1.0 - ss(44.0 * s, 102.0 * s, abs(p.y - centerSlope));

  // Vùng ánh vàng tán xạ ấm cho sương mù bay qua thung lũng
  float cx = (nx - 0.46) / 0.16;
  float cy = (ny - 0.44) / 0.075;
  outVillageWarmth = exp(-(cx * cx + cy * cy)) * (0.45 + 0.55 * lights);

  if (envX < 0.01 || bandY < 0.01) return col;

  vec2 cs = vec2(22.0, 14.0) * s;
  vec2 q = p - vec2(0.0, (nx - 0.42) * 85.0 * s);
  vec2 baseCell = floor(q / cs);

  vec3 woodC = mix(vec3(0.025, 0.038, 0.052), vec3(0.055, 0.075, 0.105), dusk);
  vec3 tileRim = mistLightCol(dusk) * 0.30;

  vec3 accumGlow = vec3(0.0);
  vec3 houseMaskCol = col;
  float houseAlpha = 0.0;

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 cell = baseCell + vec2(float(dx), float(dy));
      vec2 cellPos = (cell + 0.5) * cs;
      float cnx = cellPos.x / W;
      float cRealY = cellPos.y + (cnx - 0.42) * 85.0 * s;
      float cEnv = ss(0.21, 0.31, cnx) * (1.0 - ss(0.52, 0.66, cnx));
      float cSlope = A * (0.370 + 0.145 * ss(0.20, 0.70, cnx));
      float cBand = 1.0 - ss(36.0 * s, 80.0 * s, abs(cRealY - cSlope));
      float cluster = ss(0.26, 0.60, vnoise(cell * 0.48 + vec2(5.1, 3.3)));
      float h = hash2(cell + 41.0);
      float present = step(1.0 - 0.90 * cEnv * cBand * cluster, h);
      if (present < 0.5) continue;

      float h2 = hash2(cell + 13.7);
      float h3 = hash2(cell + 29.4);
      float bw = (7.0 + 6.5 * h2) * s;
      float bh = (3.6 + 2.8 * h3) * s;
      vec2 pos = cell * cs + vec2((cs.x - bw) * (0.2 + 0.6 * hash2(cell + 9.1)), (cs.y - bh) * (0.2 + 0.6 * hash2(cell + 5.7)));
      vec2 lq = q - pos;
      vec2 hc = vec2(bw * 0.5, bh * 0.5);

      // Tắt hẳn quầng sáng trước khi chạm rìa lưới 3x3 (<= 13*s) -> TUYỆT ĐỐI KHÔNG BỊ CẮT CẠNH Ô!
      float distGlow = length((lq - hc) * vec2(0.85, 1.15));
      float glowClip = 1.0 - ss(7.0 * s, 12.5 * s, distGlow);
      float lightLevel = (0.45 + 0.55 * h2) * (0.35 + 0.65 * lights);
      float depthFade = 1.0 - ss(0.46, 0.66, cnx) * 0.52;
      accumGlow += WIN * exp(-distGlow / (4.6 * s)) * glowClip * 0.28 * lightLevel * depthFade;

      if (abs(lq.x - hc.x) > bw * 0.85 || abs(lq.y - hc.y) > bh * 1.4) continue;

      float dBody = max(abs(lq.x - hc.x) - bw * 0.5, abs(lq.y - hc.y) - bh * 0.5);
      float bodyCov = cover(dBody, 0.75 * s);

      float roofH = bh * 0.65;
      float ry = (lq.y + roofH * 0.42);
      float roofFrac = clamp((lq.y + roofH) / roofH, 0.0, 1.0);
      float halfRoofW = mix(bw * 0.28, bw * 0.62, roofFrac);
      float dRoof = max(abs(lq.x - hc.x) - halfRoofW, abs(ry) - roofH * 0.52);
      float roofCov = cover(dRoof, 0.8 * s);

      float underEave = exp(-abs(lq.y - 0.8 * s) / (1.3 * s)) * cover(abs(lq.x - hc.x) - bw * 0.45, 0.9 * s);
      vec2 wq = vec2((lq.x - bw * 0.14) / (2.6 * s), (lq.y - bh * 0.35) / (2.0 * s));
      vec2 wi = floor(wq);
      vec2 wf = fract(wq);
      float wOn = step(0.40, hash2(wi + cell * 5.0 + floor(uTime / 14.0 + h * 7.0)));
      float winMask = cover(abs(wf.x - 0.5) - 0.20, 0.18) * cover(abs(wf.y - 0.5) - 0.22, 0.18)
                    * step(0.0, wi.x) * step(wi.x, floor(bw / (2.8 * s)) - 1.0)
                    * step(0.0, wi.y) * step(wi.y, 0.5);

      vec3 walls = woodC + LAMP_GLOW * underEave * 0.95 * lightLevel + WIN * winMask * wOn * 1.15 * lightLevel;
      vec3 roofC = woodC * 0.68 + tileRim * ss(0.0, 0.35, 1.0 - roofFrac) * 0.52;

      if (bodyCov > 0.01) {
        houseMaskCol = mix(houseMaskCol, mix(houseMaskCol, walls, depthFade), bodyCov);
        houseAlpha = max(houseAlpha, bodyCov * depthFade);
      }
      if (roofCov > 0.01) {
        houseMaskCol = mix(houseMaskCol, mix(houseMaskCol, roofC, depthFade), roofCov);
        houseAlpha = max(houseAlpha, roofCov * depthFade);
      }
    }
  }

  vec3 res = mix(col, houseMaskCol, clamp(houseAlpha, 0.0, 1.0));
  res += accumGlow;
  return res;
}

// ---------------- 5. Biển mây Xanh giờ chạng vạng (Powdery Blue-Hour Mist) ----------------
float valleyMistField(vec2 p, float W, float A, float s, float drift, float loY, float hiY, float bias, float phase) {
  vec2 q = vec2((p.x + drift * s) / (580.0 * s), p.y / (260.0 * s)) + phase;
  vec2 warp = texN(p + vec2(drift * 0.40 * s, 0.0) + phase * 310.0 * s, 960.0 * s).gb - 0.5;
  float n = smoothCloudNoise((q + warp * 0.24) * 640.0 * s, s);

  float band = ss(loY - 80.0 * s, loY + 20.0 * s, p.y) * (1.0 - ss(hiY - 20.0 * s, hiY + 95.0 * s, p.y));
  return ss(0.42 - bias, 0.80 - bias, n) * band;
}

vec3 blendMist(vec3 col, vec2 p, float W, float A, float s, float drift, float dusk, float dens, float villageWarmth, float phase) {
  if (dens < 0.005) return col;
  vec2 sq = vec2(p.x + drift * s, p.y - 18.0 * s) + phase * 240.0 * s;
  float shadeN = smoothCloudNoise(sq * 0.72, s);
  vec3 mc = mix(mistDeepCol(dusk), mistLightCol(dusk), ss(0.22, 0.76, shadeN));
  // Ánh đèn bản làng tán xạ làm ấm phần bụng mây trôi ngang thung lũng
  mc = mix(mc, vec3(0.95, 0.64, 0.34), villageWarmth * ss(0.25, 0.75, 1.0 - shadeN) * 0.34);
  return mix(col, mc, clamp(dens, 0.0, 0.92));
}

// ---------------- 6. Khóm tre tụ điểm rìa sườn & Ruộng bậc thang tiền cảnh 3D ----------------
vec3 drawForegroundRidgeTrees(vec3 col, vec2 p, float W, float A, float s, float ridgeY, float dusk) {
  float nx = p.x / W;
  float clump1 = exp(-pow((nx - 0.44) / 0.065, 2.0));
  float clump2 = exp(-pow((nx - 0.18) / 0.045, 2.0)) * 0.55;
  float clump3 = exp(-pow((nx - 0.78) / 0.055, 2.0)) * 0.45;
  float clumpW = clump1 + clump2 + clump3;
  if (clumpW < 0.03) return col;

  float canopyBase = ridgeY + 3.0 * s;
  float maxTreeH = (26.0 * clumpW) * s;
  if (p.y < canopyBase - maxTreeH - 12.0 * s || p.y > canopyBase + 6.0 * s) return col;

  float macroShape = texN(vec2(p.x * 1.1, 13.0 * s), 340.0 * s).r;
  float fineLeaf = texN(p * vec2(3.6, 3.2), 140.0 * s).a;
  float treeTop = canopyBase - maxTreeH * clamp(0.35 + macroShape * 0.75 + (fineLeaf - 0.5) * 0.35, 0.0, 1.3);

  float bambooSpike = clump1 * ss(0.64, 0.90, fineLeaf) * 14.0 * s;
  treeTop -= bambooSpike;

  float mask = cover(treeTop - p.y, 1.6 * s) * cover(p.y - (canopyBase + 4.0 * s), 1.6 * s);
  if (mask < 0.01) return col;

  vec3 darkCanopy = mix(vec3(0.018, 0.050, 0.038), vec3(0.042, 0.098, 0.068), dusk) * (0.75 + 0.45 * fineLeaf);
  float rim = ss(8.0 * s, 0.0, p.y - treeTop);
  darkCanopy = mix(darkCanopy, mistLightCol(dusk) * 0.30, rim * 0.28);
  return mix(col, darkCanopy, mask);
}

vec3 drawForegroundTerraces(vec3 col, vec2 p, float W, float A, float s, float lights, float dusk) {
  float ridgeY = fgRidgeY(p.x, W, A, s);
  if (p.y < ridgeY - 3.0 * s) return col;

  float eps = 1.5 * s;
  float T = fgPotential(p, W, A, s, ridgeY);
  float dTdx = (fgPotential(p + vec2(eps, 0.0), W, A, s, ridgeY) - fgPotential(p - vec2(eps, 0.0), W, A, s, ridgeY)) / (2.0 * eps);
  float dTdy = (fgPotential(p + vec2(0.0, eps), W, A, s, ridgeY) - fgPotential(p - vec2(0.0, eps), W, A, s, ridgeY)) / (2.0 * eps);
  vec2 gradT = vec2(dTdx, dTdy);
  float ppt = 1.0 / max(length(gradT), 1e-4);

  float f = fract(T);
  float cushion = sin(ss(0.04, 0.92, f) * 3.14159);
  float creaseShadow = ss(0.0, 0.26, f) * (1.0 - ss(0.90, 1.0, f) * 0.72);

  float bushMacro = texN(p * vec2(1.2, 2.0), 320.0 * s).r;
  float bushMicro = texN(vec2(p.x * 2.2, p.y * 3.0), 125.0 * s).a;
  float leafTex = bushMacro * 0.45 + bushMicro * 0.55;

  vec3 deepCrease = mix(vec3(0.018, 0.055, 0.040), vec3(0.032, 0.095, 0.062), dusk);
  vec3 teaBase = mix(vec3(0.045, 0.145, 0.068), vec3(0.105, 0.255, 0.105), leafTex) * mix(0.75, 1.08, dusk);
  vec3 tc = mix(deepCrease, teaBase, creaseShadow * (0.55 + 0.45 * cushion));

  float topShoulder = ss(0.45, 0.78, f) * (1.0 - ss(0.82, 0.98, f));
  float rimSmooth = topShoulder * ss(2.2 * s, 7.5 * s, ppt);
  vec3 skySheen = mix(vec3(0.10, 0.22, 0.24), vec3(0.22, 0.39, 0.46), dusk);
  tc = mix(tc, tc * 1.15 + skySheen * 0.36, rimSmooth * (0.42 + 0.34 * bushMicro));

  float depthRight = ss(0.42, 0.98, p.x / W) * (1.0 - ss(ridgeY, ridgeY + 170.0 * s, p.y));
  tc = mix(tc, mistDeepCol(dusk) * 0.85, depthRight * 0.34);

  tc = terraceLamps3x3(tc, p, T, gradT, lights, s, 1.0);
  return mix(col, tc, cover(ridgeY - p.y, 1.5 * s));
}

// ---------------- 7. Đèn trời thả từ thung lũng (Traditional Sky Lanterns) ----------------
vec3 skyLanterns(vec3 col, vec2 p, float s) {
  for (int i = 0; i < 4; i++) {
    vec4 L = uLant[i];
    if (L.z < -50.0) continue;
    float a = L.z;
    float hsd = L.w;
    vec2 c = L.xy + vec2(sin(a * 0.9 + hsd * 6.0) * 14.0 * s + a * 6.5 * s, -a * 34.0 * s);
    float fade = (1.0 - ss(7.0, 10.0, a)) * ss(0.0, 0.4, a);
    float sz = mix(1.05, 0.52, ss(0.0, 10.0, a)) * s;
    vec2 q = (p - c) / sz;
    if (abs(q.x) > 55.0 || abs(q.y) > 55.0) continue;

    float flick = 0.86 + 0.14 * sin(uTime * 13.0 + hsd * 20.0);
    float topRound = length(vec2(q.x, min(q.y + 3.5, 0.0) * 1.1)) - 6.8;
    float taperW = mix(6.8, 3.6, ss(-3.5, 8.5, q.y));
    float dBody = max(abs(q.x) - taperW, q.y - 8.5);
    dBody = max(dBody, mix(topRound, dBody, ss(-4.0, -1.0, q.y)));

    float cov = cover(dBody, 1.1) * fade;
    float ember = exp(-length(q - vec2(0.0, 6.5)) / 4.2);
    vec3 lc = mix(vec3(1.0, 0.72, 0.34), vec3(1.0, 0.94, 0.72), ember) * flick;
    col = mix(col, lc, cov);
    col += LAMP_GLOW * exp(-length(q) / 18.0) * 0.52 * fade * flick;
  }
  return col;
}

// ---------------- 8. Mây ôm biểu tượng Desktop (Blue-Hour Icon Cloud) ----------------
vec3 iconCloud(vec3 col, vec2 p, float s, float dI, float dusk) {
  if (dI > 42.0 * s) return col;
  vec3 mDeep = mistDeepCol(dusk);
  vec3 mLight = mistLightCol(dusk);
  float n = texN(p + vec2(uFog.x * s, 0.0), 260.0 * s).b;
  float edge = dI + (n - 0.5) * 44.0 * s;
  float inner = texN(p - vec2(uFog.x * 0.55 * s, 0.0) + 120.0 * s, 320.0 * s).r;
  float dens = (1.0 - ss(-24.0 * s, 18.0 * s, edge)) * mix(0.36, 0.78, ss(0.28, 0.74, inner));
  float gy = iconField(p + vec2(0.0, 4.0)) - iconField(p - vec2(0.0, 4.0));
  vec3 cc = mix(mLight * 0.92, mDeep * 0.94, ss(-1.0, 1.0, -gy * 0.4) * ss(-30.0 * s, 0.0, dI) * 0.65);
  cc = mix(cc, mLight * 1.02, ss(0.42, 0.82, n) * 0.22);
  return mix(col, cc, dens * 0.62);
}

// ---------------- Hàm chính ----------------
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y * uScale - gl_FragCoord.y) / uScale;
  float W = uRes.x, H = uRes.y;
  float A = max(280.0, H - 48.0);
  float s = min(W / 1280.0, A / 720.0);
  float lights = uScene.x, fogAmt = uScene.y, dusk = uScene.z;
  float drift = uFog.x;
  float nx = p.x / W;

  // 1. Bầu trời giờ xanh & các rặng núi rừng rậm
  vec3 col = sky(p, W, A, s, dusk, drift);
  col = drawMountainsAndValleyBasin(col, p, W, A, s, dusk, fogAmt, drift);

  // 2. Lớp mây nền thung lũng
  float bias = (fogAmt - 0.5) * 0.34;
  float fBack = valleyMistField(p, W, A, s, drift, A * 0.20, A * 0.54, bias + 0.12 * ss(0.32, 0.92, nx), 0.0);
  fBack *= mix(0.18, 1.0, ss(0.22, 0.72, nx));
  col = blendMist(col, p, W, A, s, drift, dusk, fBack * mix(0.40, 0.86, fogAmt), 0.15, 0.0);

  // 3. Sườn ruộng bậc thang trung cảnh bên trái-giữa + bản làng nương náu dưới thung
  col = drawMidTerraces(col, p, W, A, s, lights, dusk, fogAmt);
  float villageWarmth = 0.0;
  col = drawVillage(col, p, W, A, s, dusk, lights, villageWarmth);

  // 4. Khối mây chính thung lũng cuộn trào bên phải & hắt ánh vàng nhẹ từ bản làng
  float fMid = valleyMistField(p, W, A, s, drift * 1.28, A * 0.24, A * 0.62, bias + 0.15 * ss(0.42, 0.95, nx), 1.7);
  fMid *= mix(0.08, 1.0, ss(0.38, 0.84, nx));
  col = blendMist(col, p, W, A, s, drift * 1.28, dusk, fMid * mix(0.40, 0.88, fogAmt), villageWarmth, 1.7);

  // 5. Khóm tre tụ điểm rìa sườn & Đồi ruộng bậc thang 3D tiền cảnh
  float fgY = fgRidgeY(p.x, W, A, s);
  col = drawForegroundRidgeTrees(col, p, W, A, s, fgY, dusk);
  col = drawForegroundTerraces(col, p, W, A, s, lights, dusk);

  // 6. Vài làn sương rất mỏng lướt qua rìa thấp góc phải
  float fLow = valleyMistField(p, W, A, s, drift * 1.65, A * 0.52, A * 0.80, bias - 0.18, 4.3);
  fLow *= ss(0.42, 0.94, nx);
  col = blendMist(col, p, W, A, s, drift * 1.65, dusk, fLow * 0.28 * fogAmt, 0.0, 4.3);

  // 7. Đèn trời tương tác & Mây ôm icon Desktop
  col = skyLanterns(col, p, s);
  col = iconCloud(col, p, s, iconField(p), dusk);

  // 8. Hậu kỳ nhẹ giữ màu giờ xanh trong sâu, khử dải sọc 8-bit
  col = col / (1.0 + col * 0.14);
  vec2 vq = (p - vec2(0.5 * W, 0.5 * H)) / vec2(W, H);
  col *= 1.0 - dot(vq, vq) * 0.15;
  col += (hash2(p + fract(uSeed) * 100.0) - 0.5) / 255.0;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}
