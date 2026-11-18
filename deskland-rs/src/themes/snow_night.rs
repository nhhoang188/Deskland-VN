//! Chủ đề Đêm tuyết ngắm phố (prototype/snow-night.html):
//! Đỉnh đồi tuyết nhìn xuống thành phố lên đèn, rặng thông phủ tuyết hai bên, tuyết rơi 3 lớp
//! và một phi hành gia ngồi trên nóc chiếc xe đỏ kéo violin. Click: thành phố bắn pháo hoa, rung cây
//! rụng tuyết, trời nổi gió giật, phi hành gia kéo đàn hăng say.
//! Quãng rơi của tuyết và quãng trôi theo gió được cộng dồn ở đây nên đổi gió không giật.
//! Shader dùng chung một nguồn duy nhất: prototype/snow-night.frag. Giữ logic khớp với bản web.

use crate::engine::*;

pub const FRAG: &str = include_str!("../../../prototype/snow-night.frag");

pub struct Params {
    pub snow: f32,
    pub wind: f32,
    pub lights: f32,
    pub show_kid: f32,
    pub sigma: f32,
    pub warp: f32,
}

impl Params {
    pub fn from_json(v: Option<&serde_json::Value>) -> Self {
        let g = |k: &str, d: f32| v.and_then(|o| o.get(k)).and_then(|x| x.as_f64()).map(|x| x as f32).unwrap_or(d);
        Params {
            snow: g("snow", 0.6).clamp(0.0, 1.0),
            wind: g("wind", 0.25).clamp(-1.0, 1.0),
            lights: g("lights", 0.8).clamp(0.0, 1.0),
            show_kid: if g("showKid", 1.0) >= 0.5 { 1.0 } else { 0.0 },
            sigma: g("sigma", 75.0).clamp(45.0, 160.0),
            warp: g("warp", 24.0).clamp(0.0, 60.0),
        }
    }
}

#[derive(Clone, Copy)]
struct Burst {
    x: f32,
    y: f32,
    age: f32,
    hue: f32,
}

const NONE: Burst = Burst { x: 0.0, y: 0.0, age: -99.0, hue: 0.0 };

struct Metrics {
    a: f32,
    s: f32,
    hz: f32,
    ridge: f32,
}

pub struct SnowNight {
    b: Base,
    p: Params,
    rng: Rng,
    t0: f64,
    fall: f64,
    drift: f64,
    wind: f32,
    gust: f32,
    sway: f32,
    sway_vel: f32,
    bow_phase: f32,
    note_phase: f32,
    inten: f32,
    play_t: f32,
    user_active_timer: f32,
    bursts: [Burst; 4],
}

impl SnowNight {
    pub fn new(gl: &glow::Context, w: f32, h: f32, buf_w: i32, buf_h: i32, scale: f32, seed: i32, p: Params, rng_seed: u64, now: f64) -> Self {
        let wind = p.wind;
        let mut s = Self {
            b: Base::new(gl, w, h, buf_w, buf_h, scale, seed),
            p,
            rng: Rng::new(rng_seed),
            t0: now,
            fall: 0.0,
            drift: 0.0,
            wind,
            gust: 0.0,
            sway: 0.0,
            sway_vel: 0.0,
            bow_phase: 0.0,
            note_phase: 0.0,
            inten: 0.0,
            play_t: 0.0,
            user_active_timer: 0.0,
            bursts: [NONE; 4],
        };
        s.b.commit(gl, &[], s.p.sigma, s.p.warp, true, now);
        s
    }

    /// Thông số khung cảnh, khớp hàm main() của shader
    fn metrics(&self) -> Metrics {
        let a = (self.b.h - 48.0).max(280.0);
        let s = (self.b.w / 1280.0).min(a / 720.0);
        Metrics { a, s, hz: a * 0.46, ridge: a * 0.645 }
    }

    fn add_burst(&mut self, x: f32, y: f32, age: f32, hue: f32) {
        let i = self
            .bursts
            .iter()
            .position(|b| b.age < -50.0)
            .unwrap_or_else(|| (0..4).max_by(|&i, &j| self.bursts[i].age.total_cmp(&self.bursts[j].age)).unwrap_or(0));
        self.bursts[i] = Burst { x, y, age, hue };
    }

    fn step(&mut self, dt: f32) {
        self.fall = (self.fall + (dt * (0.75 + 0.5 * self.p.snow)) as f64).rem_euclid(3600.0);
        self.gust *= (-dt * 0.9).exp();
        let target = self.p.wind + self.gust;
        self.wind += (target - self.wind) * (dt * 1.6).min(1.0);
        self.drift = (self.drift + (self.wind * dt * 38.0) as f64) % 100_000.0;
        // Cây rung: lò xo tắt dần
        self.sway_vel += (-self.sway * 16.0 - self.sway_vel * 2.4) * dt;
        self.sway += self.sway_vel * dt;

        // Phi hành gia: nhịp kéo vĩ tăng/giảm êm theo độ hăng say (cộng dồn pha nên không giật)
        self.play_t = (self.play_t - dt).max(0.0);
        let target = if self.play_t > 0.0 { 1.0 } else { 0.0 };
        self.inten += (target - self.inten) * (dt * 2.5).min(1.0);
        self.bow_phase = (self.bow_phase + dt * (1.5 + 2.6 * self.inten)) % (std::f32::consts::PI * 400.0);
        self.note_phase = (self.note_phase + dt * (0.22 + 0.25 * self.inten)) % 1000.0;

        for b in &mut self.bursts {
            if b.age > -50.0 {
                b.age += dt;
                if b.age > if b.hue < 0.0 { 1.8 } else { 2.6 } {
                    b.age = -99.0;
                }
            }
        }
        self.user_active_timer = (self.user_active_timer - dt).max(0.0);
    }

    fn draw(&mut self, gl: &glow::Context, sh: &mut Shared, now: f64) {
        let t = ((now - self.t0) / 1000.0) as f32;
        let p = &mut sh.prog;
        unsafe { glow::HasContext::use_program(gl, Some(p.prog)) };
        self.b.bind_common(gl, p, sh.noise_tex, sh.seed, t);

        p.f4v(gl, "uScene", &[self.p.snow, self.p.lights, self.p.show_kid, 0.0]);
        p.f4v(gl, "uSnow", &[self.fall as f32, self.drift as f32, self.wind, self.sway + self.wind * 0.25]);
        p.f4v(gl, "uKid", &[self.bow_phase.sin(), (self.bow_phase * 0.5).sin(), self.inten, self.note_phase]);
        let mut bu = [0f32; 16];
        for (i, b) in self.bursts.iter().enumerate() {
            bu[i * 4..i * 4 + 4].copy_from_slice(&[b.x, b.y, b.age, b.hue]);
        }
        p.f4v(gl, "uBursts", &bu);
        unsafe { glow::HasContext::draw_arrays(gl, glow::TRIANGLES, 0, 3) };
    }
}

impl Theme for SnowNight {
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
        let m = self.metrics();
        let w = self.b.w;
        self.user_active_timer = 2.5;

        // 1. Phi hành gia & xe -> kéo đàn hăng say
        if self.p.show_kid > 0.5 && (x - w * 0.5).abs() < 190.0 * m.s && y > m.a * 0.86 - 230.0 * m.s && y < m.a * 0.86 + 20.0 * m.s {
            self.play_t = 4.5;
            return;
        }
        // 2. Rặng thông hai bên -> cây rung, tuyết rụng
        if (x < w * 0.24 || x > w * 0.76) && y < m.ridge + 10.0 * m.s {
            self.sway_vel += if x < w * 0.5 { 2.6 } else { -2.6 };
            self.add_burst(x, y, 0.0, -1.0);
            return;
        }
        // 3. Thành phố / bầu trời phía trên thành phố -> pháo hoa
        if x > w * 0.22 && x < w * 0.78 && y < m.hz + 46.0 * m.s {
            let ty = y.min(m.hz - 165.0 * m.s).max(m.hz * 0.22);
            let hue = self.rng.next();
            self.add_burst(x, ty, -0.9, hue);
            return;
        }
        // 4. Bầu trời còn lại -> gió giật
        if y < m.ridge {
            self.gust = if x < w * 0.5 { -1.4 } else { 1.4 };
            return;
        }
        // 5. Bãi tuyết -> phi hành gia kéo đàn hăng say
        if self.p.show_kid > 0.5 {
            self.play_t = 4.5;
        }
    }

    fn is_interacting(&self, _now: f64) -> bool {
        self.user_active_timer > 0.0
            || self.play_t > 0.0
            || self.inten > 0.02
            || self.sway_vel.abs() > 0.02
            || self.gust.abs() > 0.05
            || self.bursts.iter().any(|b| b.age > -50.0)
    }

    fn destroy(&mut self, gl: &glow::Context) {
        self.b.destroy(gl);
    }

    fn field_ms(&self) -> f64 {
        self.b.field_ms
    }
}
