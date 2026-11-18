//! Chủ đề Ruộng bậc thang lên đèn (prototype/terrace-lights.html):
//! Giờ xanh chạng vạng trên vùng núi: ruộng bậc thang uốn lượn với hàng nghìn đốm đèn dọc bờ ruộng,
//! bản làng dưới thung sáng đèn, biển mây trôi chậm qua thung lũng và núi xa xanh mờ.
//! Click: ruộng bừng sáng theo vòng lan, thả đèn trời từ thung lũng, bầu trời nổi gió đẩy mây.
//! Quãng trôi của mây được cộng dồn ở đây nên đổi tốc độ không giật.
//! Shader dùng chung một nguồn duy nhất: prototype/terrace-lights.frag. Giữ logic khớp với bản web.

use crate::engine::*;

pub const FRAG: &str = include_str!("../../../prototype/terrace-lights.frag");

pub struct Params {
    pub lights: f32,
    pub fog: f32,
    pub fog_speed: f32,
    pub dusk: f32,
    pub sigma: f32,
    pub warp: f32,
}

impl Params {
    pub fn from_json(v: Option<&serde_json::Value>) -> Self {
        let g = |k: &str, d: f32| v.and_then(|o| o.get(k)).and_then(|x| x.as_f64()).map(|x| x as f32).unwrap_or(d);
        Params {
            lights: g("lights", 0.7).clamp(0.0, 1.0),
            fog: g("fog", 0.65).clamp(0.0, 1.0),
            fog_speed: g("fogSpeed", 1.0).clamp(0.0, 4.0),
            dusk: g("dusk", 0.6).clamp(0.0, 1.0),
            sigma: g("sigma", 75.0).clamp(45.0, 160.0),
            warp: g("warp", 28.0).clamp(0.0, 60.0),
        }
    }
}

#[derive(Clone, Copy)]
struct Fx {
    x: f32,
    y: f32,
    age: f32,
    seed: f32,
}

const NONE: Fx = Fx { x: 0.0, y: 0.0, age: -99.0, seed: 0.0 };

fn oldest_free(arr: &[Fx]) -> usize {
    arr.iter()
        .position(|o| o.age < -50.0)
        .unwrap_or_else(|| (0..arr.len()).max_by(|&i, &j| arr[i].age.total_cmp(&arr[j].age)).unwrap_or(0))
}

pub struct TerraceLights {
    b: Base,
    p: Params,
    rng: Rng,
    t0: f64,
    drift: f64,
    gust: f32,
    user_active_timer: f32,
    waves: [Fx; 2],
    lants: [Fx; 4],
}

impl TerraceLights {
    pub fn new(gl: &glow::Context, w: f32, h: f32, buf_w: i32, buf_h: i32, scale: f32, seed: i32, p: Params, rng_seed: u64, now: f64) -> Self {
        let mut s = Self {
            b: Base::new(gl, w, h, buf_w, buf_h, scale, seed),
            p,
            rng: Rng::new(rng_seed),
            t0: now,
            drift: 0.0,
            gust: 0.0,
            user_active_timer: 0.0,
            waves: [NONE; 2],
            lants: [NONE; 4],
        };
        s.b.commit(gl, &[], s.p.sigma, s.p.warp, true, now);
        s
    }

    fn step(&mut self, dt: f32) {
        self.gust *= (-dt * 0.5).exp();
        self.drift = (self.drift + (dt * self.p.fog_speed * (10.0 + 60.0 * self.gust)) as f64) % 100_000.0;
        for w in &mut self.waves {
            if w.age > -50.0 {
                w.age += dt;
                if w.age > 4.0 {
                    w.age = -99.0;
                }
            }
        }
        for l in &mut self.lants {
            if l.age > -50.0 {
                l.age += dt;
                if l.age > 10.0 {
                    l.age = -99.0;
                }
            }
        }
        self.user_active_timer = (self.user_active_timer - dt).max(0.0);
    }

    fn draw(&mut self, gl: &glow::Context, sh: &mut Shared, now: f64) {
        let t = (((now - self.t0) / 1000.0) % 3600.0) as f32;
        let p = &mut sh.prog;
        unsafe { glow::HasContext::use_program(gl, Some(p.prog)) };
        self.b.bind_common(gl, p, sh.noise_tex, sh.seed, t);
        p.f4v(gl, "uScene", &[self.p.lights, self.p.fog, self.p.dusk, 0.0]);
        p.f4v(gl, "uFog", &[self.drift as f32, self.gust, 0.0, 0.0]);
        let mut wv = [0f32; 8];
        for (i, w) in self.waves.iter().enumerate() {
            wv[i * 4..i * 4 + 4].copy_from_slice(&[w.x, w.y, w.age, 0.0]);
        }
        p.f4v(gl, "uWave", &wv);
        let mut lt = [0f32; 16];
        for (i, l) in self.lants.iter().enumerate() {
            lt[i * 4..i * 4 + 4].copy_from_slice(&[l.x, l.y, l.age, l.seed]);
        }
        p.f4v(gl, "uLant", &lt);
        unsafe { glow::HasContext::draw_arrays(gl, glow::TRIANGLES, 0, 3) };
    }
}

impl Theme for TerraceLights {
    fn set_icons(&mut self, gl: &glow::Context, icons: Vec<IconBox>, first: bool, now: f64) {
        self.b.icons = icons;
        let rects = icon_rects(&self.b.icons);
        self.b.commit(gl, &rects, self.p.sigma, self.p.warp, first, now);
    }

    fn frame(&mut self, gl: &glow::Context, sh: &mut Shared, dt: f32, now: f64) {
        self.b.update_mix(now);
        self.step(dt.min(0.1));
        self.draw(gl, sh, now);
    }

    fn settle(&mut self, gl: &glow::Context, sh: &mut Shared, now: f64) {
        self.b.settle();
        self.draw(gl, sh, now);
    }

    fn handle_click(&mut self, _gl: &glow::Context, x: f32, y: f32, _now: f64) {
        let w = self.b.w;
        let a = (self.b.h - 48.0).max(280.0);
        let s = (w / 1280.0).min(a / 720.0);
        self.user_active_timer = 2.5;
        let nx = (x / w).clamp(0.0, 1.0);
        let t = (nx * 0.92 + 0.04).clamp(0.0, 1.0);
        let smooth_t = t * t * (3.0 - 2.0 * t);
        let top_fg = a * (0.395 + 0.275 * smooth_t)
            - (nx * 5.2 + 0.4).sin() * 14.0 * s
            + (nx * 10.5 - 0.8).cos() * 4.5 * s;
        // 1. Bầu trời phía trên đỉnh núi -> gió đẩy biển mây trôi nhanh
        if y < a * 0.20 {
            self.gust = 1.0;
            return;
        }
        // 2. Đồi ruộng bậc thang phía trước -> sóng đèn bừng sáng lan ra
        if y > top_fg {
            let i = oldest_free(&self.waves);
            self.waves[i] = Fx { x, y, age: 0.0, seed: 0.0 };
            return;
        }
        // 3. Thung lũng, bản làng & sườn núi -> thả đèn trời bay lên
        let i = oldest_free(&self.lants);
        let seed = self.rng.next();
        self.lants[i] = Fx { x, y, age: 0.0, seed };
    }

    fn is_interacting(&self, _now: f64) -> bool {
        self.user_active_timer > 0.0
            || self.gust > 0.03
            || self.waves.iter().any(|w| w.age > -50.0)
            || self.lants.iter().any(|l| l.age > -50.0)
    }

    fn destroy(&mut self, gl: &glow::Context) {
        self.b.destroy(gl);
    }

    fn field_ms(&self) -> f64 {
        self.b.field_ms
    }
}
