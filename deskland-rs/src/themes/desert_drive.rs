//! Chủ đề Cung đường sa mạc (prototype/desert-drive.html):
//! Con đường thẳng tắp xuyên sa mạc cam, vầng dương lớn sau dãy núi tím, khối núi sa thạch giật cấp,
//! bụi cây xám xanh, cây Joshua và chiếc xe thể thao 80s màu hồng nhìn từ phía sau.
//! Mặt đất được vẽ trong toạ độ thế giới nên mọi thứ trôi đúng phối cảnh. Quãng đường đã chạy được
//! cộng dồn ở đây (không nhân thời gian với tốc độ) nên đổi tốc độ/Nitro không bị giật pha,
//! và shader làm nhoè vạch kẻ theo quãng đường của một khung hình để mượt cả ở 20 FPS.
//! Shader dùng chung một nguồn duy nhất: prototype/desert-drive.frag. Giữ logic khớp với bản web.

use crate::engine::*;
use windows_sys::Win32::Foundation::SYSTEMTIME;

extern "system" {
    fn GetLocalTime(lpSystemTime: *mut SYSTEMTIME);
}

pub const FRAG: &str = include_str!("../../../prototype/desert-drive.frag");

/// Chu kỳ quấn vòng quãng đường (bội số của mọi chu kỳ hoa văn trong shader)
const WRAP: f64 = 660.0;
const BASE_SPEED: f32 = 1.1;

pub struct Params {
    pub time_of_day: i32,
    pub speed: f32,
    pub car_color: i32,
    pub traffic: f32,
    pub cloud_speed: f32,
    pub sigma: f32,
    pub warp: f32,
}

impl Params {
    pub fn from_json(v: Option<&serde_json::Value>) -> Self {
        let g = |k: &str, d: f32| v.and_then(|o| o.get(k)).and_then(|x| x.as_f64()).map(|x| x as f32).unwrap_or(d);
        Params {
            time_of_day: (g("timeOfDay", 0.0).round() as i32).clamp(0, 3),
            speed: g("speed", 1.0).clamp(0.5, 2.5),
            car_color: (g("carColor", 0.0).round() as i32).clamp(0, 3),
            traffic: g("traffic", 0.6).clamp(0.0, 1.0),
            cloud_speed: g("cloudSpeed", 1.0).clamp(0.0, 4.0),
            sigma: g("sigma", 75.0).clamp(45.0, 160.0),
            warp: g("warp", 26.0).clamp(0.0, 60.0),
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Tumbleweed {
    x: f32,
    y: f32,
    rot: f32,
    scale: f32,
}

struct Metrics {
    s: f32,
    hz: f32,
    d0: f32,
    g: f32,
}

pub struct DesertDrive {
    b: Base,
    p: Params,
    rng: Rng,
    t0: f64,
    time: f32,
    dist: f64,
    cloud_drift: f64,
    frame_blur: f32,
    car_lane: f32,
    car_lane_target: f32,
    lane_vel: f32,
    steer_tilt: f32,
    bob_y: f32,
    boost: f32,
    flame_length: f32,
    signal_l: f32,
    signal_r: f32,
    shake: f32,
    shake_off: f32,
    user_active_timer: f32,
    props: [Tumbleweed; 4],
}

impl DesertDrive {
    pub fn new(gl: &glow::Context, w: f32, h: f32, buf_w: i32, buf_h: i32, scale: f32, seed: i32, p: Params, rng_seed: u64, now: f64) -> Self {
        let mut s = Self {
            b: Base::new(gl, w, h, buf_w, buf_h, scale, seed),
            p,
            rng: Rng::new(rng_seed),
            t0: now,
            time: 0.0,
            dist: 0.0,
            cloud_drift: 0.0,
            frame_blur: 0.0,
            car_lane: 0.0,
            car_lane_target: 0.0,
            lane_vel: 0.0,
            steer_tilt: 0.0,
            bob_y: 0.0,
            boost: 0.0,
            flame_length: 0.0,
            signal_l: 0.0,
            signal_r: 0.0,
            shake: 0.0,
            shake_off: 0.0,
            user_active_timer: 0.0,
            props: [Tumbleweed::default(); 4],
        };
        s.b.commit(gl, &[], s.p.sigma, s.p.warp, true, now);
        s
    }

    /// Thông số khung cảnh, khớp hàm main() của shader
    fn metrics(&self) -> Metrics {
        let avail_h = (self.b.h - 48.0).max(280.0);
        let s = (self.b.w / 1280.0).min(avail_h / 720.0);
        let hz = avail_h * 0.47;
        let d0 = avail_h - hz;
        Metrics { s, hz, d0, g: 340.0 * s / d0 }
    }

    fn spawn_tumbleweed(&mut self, x: f32, y: f32) {
        let m = self.metrics();
        let r1 = self.rng.next();
        let r2 = self.rng.next();
        if let Some(tw) = self.props.iter_mut().find(|t| t.scale < 0.05) {
            tw.x = x;
            tw.y = y.max(m.hz + m.d0 * 0.12);
            tw.rot = r1 * 6.28;
            tw.scale = (0.45 + 0.9 * (tw.y - m.hz) / m.d0) * (0.85 + r2 * 0.3);
        }
    }

    fn tod(&self) -> f32 {
        match self.p.time_of_day {
            1 => 0.50, // Trưa nắng
            2 => 0.72, // Hoàng hôn (như ảnh gốc)
            3 => 0.95, // Đêm sao
            _ => unsafe {
                // Tự động theo giờ máy
                let mut st: SYSTEMTIME = std::mem::zeroed();
                GetLocalTime(&mut st);
                let mins = st.wHour as u32 * 60 + st.wMinute as u32;
                if (600..990).contains(&mins) {
                    0.50
                } else if (990..1125).contains(&mins) {
                    0.72
                } else if (330..600).contains(&mins) {
                    0.25
                } else {
                    0.95
                }
            },
        }
    }

    fn step(&mut self, dt: f32) {
        self.time += dt;
        let m = self.metrics();

        // Chuyển làn: lò xo giảm chấn gần tới hạn nên lướt êm, không lắc qua lại
        let accel = (self.car_lane_target - self.car_lane) * 14.0 - self.lane_vel * 7.0;
        self.lane_vel += accel * dt;
        self.car_lane += self.lane_vel * dt;
        self.steer_tilt = self.lane_vel * 0.6;

        self.boost = (self.boost - dt * 0.35).max(0.0);
        self.flame_length = (self.flame_length - dt * 0.5).max(0.0);
        self.shake = (self.shake - dt * 1.6).max(0.0);
        let b = self.boost * self.boost * (3.0 - 2.0 * self.boost);
        let v = BASE_SPEED * self.p.speed * (1.0 + 2.2 * b);
        self.frame_blur = v * dt;
        self.dist = (self.dist + (v * dt) as f64).rem_euclid(WRAP);
        // Mây trôi theo quãng cộng dồn nên kéo thanh tốc độ không làm mây nhảy chỗ
        self.cloud_drift = (self.cloud_drift + (dt * self.p.cloud_speed) as f64).rem_euclid(100_000.0);

        // Nhún nhẹ tần số thấp (mượt cả ở 20 FPS)
        let t = self.time;
        self.bob_y = ((t * 2.7).sin() * 0.6 + (t * 4.3 + 1.0).sin() * 0.35) * (1.0 + self.boost * 1.5);
        self.shake_off = self.shake * (t * 29.0).sin();

        self.signal_l = (self.signal_l - dt).max(0.0);
        self.signal_r = (self.signal_r - dt).max(0.0);
        self.user_active_timer = (self.user_active_timer - dt).max(0.0);

        let w = self.b.w;
        for tw in &mut self.props {
            if tw.scale < 0.05 {
                continue;
            }
            let r = 15.0 * tw.scale * m.s;
            let vx = (55.0 + 45.0 * tw.scale) * m.s;
            tw.x += dt * vx;
            tw.rot += dt * vx / r;
            if tw.x > w + 60.0 * m.s {
                tw.scale = 0.0;
            }
        }
        if self.rng.next() < dt * 0.10 * self.p.traffic {
            let y = m.hz + m.d0 * (0.2 + 0.75 * self.rng.next());
            self.spawn_tumbleweed(-40.0 * m.s, y);
        }
    }

    fn draw(&mut self, gl: &glow::Context, sh: &mut Shared, now: f64) {
        let t = ((now - self.t0) / 1000.0) as f32;
        let tod = self.tod();
        let p = &mut sh.prog;
        unsafe { glow::HasContext::use_program(gl, Some(p.prog)) };
        self.b.bind_common(gl, p, sh.noise_tex, sh.seed, t);

        p.f4v(gl, "uScene", &[tod, self.p.speed, self.boost, self.p.car_color as f32]);
        p.f4v(gl, "uCar", &[self.car_lane, self.bob_y, self.steer_tilt, self.dist as f32]);
        p.f4v(
            gl,
            "uEffects",
            &[
                self.flame_length,
                if self.signal_l > 0.0 { 1.0 } else { 0.0 },
                if self.signal_r > 0.0 { 1.0 } else { 0.0 },
                self.shake_off,
            ],
        );
        p.f4v(gl, "uDrive", &[self.frame_blur, self.cloud_drift as f32, 0.0, 0.0]);

        let mut props_u = [0f32; 16];
        for (i, tw) in self.props.iter().enumerate() {
            props_u[i * 4..i * 4 + 4].copy_from_slice(&[tw.x, tw.y, tw.rot, tw.scale]);
        }
        p.f4v(gl, "uProps", &props_u);

        unsafe { glow::HasContext::draw_arrays(gl, glow::TRIANGLES, 0, 3) };
    }
}

impl Theme for DesertDrive {
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
        self.frame_blur = 0.0;
        self.draw(gl, sh, now);
    }

    fn handle_click(&mut self, _gl: &glow::Context, x: f32, y: f32, _now: f64) {
        let m = self.metrics();
        self.user_active_timer = 2.5;

        // 1. Bầu trời -> đổi buổi (Tự động -> Trưa -> Hoàng hôn -> Đêm)
        if y < m.hz {
            self.p.time_of_day = (self.p.time_of_day + 1) % 4;
            return;
        }

        // 2. Xe -> Nitro phụt lửa
        let car_dy = 0.56 * m.d0;
        let car_x = self.b.w * 0.5 + self.car_lane * 0.55 * car_dy * m.g;
        let car_y = m.hz + car_dy;
        if (x - car_x).abs() < 105.0 * m.s && y > car_y - 140.0 * m.s && y < car_y + 12.0 * m.s {
            self.boost = 1.0;
            self.flame_length = 1.0;
            self.shake = 2.5;
            return;
        }

        // 3. Mặt đường -> chuyển làn
        let road_half = (y - m.hz) * m.g;
        if (x - self.b.w * 0.5).abs() < road_half * 1.1 {
            if x < car_x {
                self.car_lane_target = (self.car_lane_target - 0.65).max(-0.65);
                self.signal_l = 2.0;
                self.signal_r = 0.0;
            } else {
                self.car_lane_target = (self.car_lane_target + 0.65).min(0.65);
                self.signal_r = 2.0;
                self.signal_l = 0.0;
            }
            return;
        }

        // 4. Bãi cát -> thả cỏ lăn
        self.spawn_tumbleweed(x, y);
    }

    fn is_interacting(&self, _now: f64) -> bool {
        self.user_active_timer > 0.0
            || self.boost > 0.0
            || self.lane_vel.abs() > 0.02
            || self.props.iter().any(|t| t.scale > 0.05)
    }

    fn destroy(&mut self, gl: &glow::Context) {
        self.b.destroy(gl);
    }

    fn field_ms(&self) -> f64 {
        self.b.field_ms
    }
}
