//! Chủ đề Boxing xả stress Chibi (gymo-boxing):
//! Vẽ lại nhân vật theo phong cách Chibi miệng cười tươi (tóc nâu mái thưa, kẹp ngọc trai,
//! kính gọng đen nửa viền, áo thun đen, dây chuyền bạc, cốc sứ dưa hấu).
//! Mỗi khi click chuột lên các bộ phận, găng tay Boxing lao vào đấm làm cơ thể biến dạng
//! đàn hồi kiểu bánh mochi / hoạt hình GIF (Squash & Stretch) kèm khói tròn puff vui nhộn.

use crate::engine::*;
use glow::HasContext;
use std::f32::consts::PI;

pub const FRAG: &str = include_str!("../../assets/shaders/gymo_boxing.frag");

pub struct Params {
    pub bounciness: f32,
    pub punch_power: f32,
    pub glove_style: f32,
    pub backdrop: f32,
    pub auto_punch: f32,
}

impl Params {
    pub fn from_json(v: Option<&serde_json::Value>) -> Self {
        let g = |k: &str, d: f32| v.and_then(|o| o.get(k)).and_then(|x| x.as_f64()).map(|x| x as f32).unwrap_or(d);
        Params {
            bounciness: g("bounciness", 1.2).clamp(0.4, 2.5),
            punch_power: g("punchPower", 1.0).clamp(0.5, 2.5),
            glove_style: g("gloveStyle", 0.0).clamp(0.0, 2.0),
            backdrop: g("backdrop", 0.0).clamp(0.0, 2.0),
            auto_punch: g("autoPunch", 0.0).clamp(0.0, 2.0),
        }
    }
}

/// Lò xo giảm chấn bậc 2 (Underdamped Harmonic Oscillator) tạo độ nảy dẻo như GIF hoạt hình.
#[derive(Clone, Copy, Default)]
struct Spring {
    pos: f32,
    vel: f32,
}

impl Spring {
    fn step(&mut self, dt: f32, omega: f32, zeta: f32, limit: f32) {
        // Chia bước nhỏ để luôn ổn định tuyệt đối ở cả 20 FPS lẫn 50 FPS
        let sub = 3;
        let h = dt / sub as f32;
        for _ in 0..sub {
            let acc = -omega * omega * self.pos - 2.0 * zeta * omega * self.vel;
            self.vel += acc * h;
            self.pos += self.vel * h;
        }
        if self.pos > limit {
            self.pos = limit;
            self.vel *= -0.35;
        } else if self.pos < -limit {
            self.pos = -limit;
            self.vel *= -0.35;
        }
        if self.pos.abs() < 1e-4 && self.vel.abs() < 1e-3 {
            self.pos = 0.0;
            self.vel = 0.0;
        }
    }

    fn kick(&mut self, dv: f32) {
        self.vel += dv;
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HitZone {
    HeadTop,
    CheekLeft,
    CheekRight,
    NoseCenter,
    ShoulderLeft,
    ShoulderRight,
    TorsoBelly,
    Mug,
}

#[derive(Clone, Copy)]
struct PunchSlot {
    active: bool,
    zone: HitZone,
    orig_x: f32,
    orig_y: f32,
    tx: f32,
    ty: f32,
    dir: f32,
    kind: f32, // 0=ngang, 1=đập đỉnh đầu, 2=đấm thẳng trực diện
    age: f32,
    hit_applied: bool,
}

impl Default for PunchSlot {
    fn default() -> Self {
        Self {
            active: false,
            zone: HitZone::HeadTop,
            orig_x: 0.0,
            orig_y: 0.0,
            tx: 0.0,
            ty: 0.0,
            dir: 0.0,
            kind: 0.0,
            age: 0.0,
            hit_applied: false,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct PuffBurst {
    active: bool,
    x: f32,
    y: f32,
    age: f32,
    seed: f32,
}

pub struct GymoBoxing {
    b: Base,
    p: Params,
    rng: Rng,
    // Hệ 12 lò xo đàn hồi cho Đầu, Má, Kính, Tóc, Thân, Vai, Dây chuyền & Cốc dưa hấu
    head_x: Spring,
    head_y: Spring,
    head_rot: Spring,
    head_squash: Spring,
    face_dent: (f32, f32),
    face_push_x: Spring,
    face_push_y: Spring,
    glass_x: Spring,
    glass_y: Spring,
    glass_rot: Spring,
    hair_whip: Spring,
    torso_x: Spring,
    torso_y: Spring,
    torso_shear: Spring,
    torso_squash: Spring,
    arm_l: Spring,
    arm_r: Spring,
    necklace_ang: Spring,
    body_dent: Spring,
    desk_shake: Spring,
    mug_hop_y: f32,
    mug_hop_vy: f32,
    mug_tilt: Spring,
    // Biểu cảm & nhịp đấm
    wince_timer: f32,
    dizzy_timer: f32,
    smile_boost: f32,
    blink_cd: f32,
    blink_prog: f32,
    combo_count: u32,
    last_hit_gap: f32,
    auto_cd: f32,
    punches: [PunchSlot; 4],
    next_punch_slot: usize,
    puffs: [PuffBurst; 6],
    next_puff_slot: usize,
    interact_until: f64,
    anim_t: f32,
    t0: f64,
}

impl GymoBoxing {
    pub fn new(gl: &glow::Context, w: f32, h: f32, buf_w: i32, buf_h: i32, scale: f32, seed: i32, p: Params, rng_seed: u64, now: f64) -> Self {
        let mut s = GymoBoxing {
            b: Base::new(gl, w, h, buf_w, buf_h, scale, seed),
            p,
            rng: Rng::new(rng_seed),
            head_x: Spring::default(),
            head_y: Spring::default(),
            head_rot: Spring::default(),
            head_squash: Spring::default(),
            face_dent: (0.0, 0.0),
            face_push_x: Spring::default(),
            face_push_y: Spring::default(),
            glass_x: Spring::default(),
            glass_y: Spring::default(),
            glass_rot: Spring::default(),
            hair_whip: Spring::default(),
            torso_x: Spring::default(),
            torso_y: Spring::default(),
            torso_shear: Spring::default(),
            torso_squash: Spring::default(),
            arm_l: Spring::default(),
            arm_r: Spring::default(),
            necklace_ang: Spring::default(),
            body_dent: Spring::default(),
            desk_shake: Spring::default(),
            mug_hop_y: 0.0,
            mug_hop_vy: 0.0,
            mug_tilt: Spring::default(),
            wince_timer: 0.0,
            dizzy_timer: 0.0,
            smile_boost: 0.0,
            blink_cd: 2.4,
            blink_prog: 0.0,
            combo_count: 0,
            last_hit_gap: 99.0,
            auto_cd: 0.65,
            punches: [PunchSlot::default(); 4],
            next_punch_slot: 0,
            puffs: [PuffBurst::default(); 6],
            next_puff_slot: 0,
            interact_until: 0.0,
            anim_t: 0.0,
            t0: now,
        };
        s.b.commit(gl, &[], 80.0, 28.0, true, now);
        s
    }

    fn ui_scale(&self) -> f32 {
        (self.b.w.min(self.b.h) / 900.0).max(0.5)
    }

    fn anchors(&self) -> (f32, f32, (f32, f32), (f32, f32)) {
        let s0 = self.ui_scale();
        let s = s0 * 1.22;
        let avail_h = (self.b.h - TASKBAR).max(280.0);
        let desk_y = avail_h * 0.80;
        let cx = self.b.w * 0.5;
        let head = (cx, desk_y - 252.0 * s);
        let torso = (cx, desk_y - 88.0 * s);
        (s, desk_y, head, torso)
    }

    fn spawn_puff(&mut self, x: f32, y: f32) {
        let slot = self.next_puff_slot % self.puffs.len();
        self.next_puff_slot = self.next_puff_slot.wrapping_add(1);
        self.puffs[slot] = PuffBurst {
            active: true,
            x,
            y,
            age: 0.0,
            seed: 0.1 + self.rng.next() * 0.9,
        };
    }

    /// Phân vùng bộ phận trúng đòn từ tọa độ click `(x, y)` và phóng găng tay Boxing vào đúng vị trí!
    fn launch_punch_at(&mut self, x: f32, y: f32, now: f64) {
        let (s, desk_y, base_head, base_torso) = self.anchors();
        let cx = self.b.w * 0.5;

        // 1. Kiểm tra nếu người dùng gõ vào chiếc cốc sứ dưa hấu bên phải bàn!
        let s0 = self.ui_scale();
        let mug_x = cx + 290.0 * s0;
        let mug_y = desk_y - 24.0 * s0;
        if (x - mug_x).abs() < 62.0 * s0 && (y - mug_y).abs() < 56.0 * s0 {
            let slot = self.next_punch_slot % self.punches.len();
            self.next_punch_slot = self.next_punch_slot.wrapping_add(1);
            let orig_x = mug_x + 170.0 * s;
            let orig_y = mug_y - 120.0 * s;
            self.punches[slot] = PunchSlot {
                active: true,
                zone: HitZone::Mug,
                orig_x,
                orig_y,
                tx: mug_x,
                ty: mug_y,
                dir: (mug_y - orig_y).atan2(mug_x - orig_x),
                kind: 0.0,
                age: 0.0,
                hit_applied: false,
            };
            self.interact_until = now + 2_200.0;
            return;
        }

        // Tọa độ tương đối so với tâm Đầu Chibi hiện tại (quy về đơn vị chuẩn 900p)
        let cur_hx = base_head.0 + self.head_x.pos * s;
        let cur_hy = base_head.1 + self.head_y.pos * s;
        let hx = (x - cur_hx) / s;
        let hy = (y - cur_hy) / s;

        let zone = if hy < -42.0 {
            HitZone::HeadTop
        } else if hy < 86.0 {
            if hx < -26.0 {
                HitZone::CheekLeft
            } else if hx > 26.0 {
                HitZone::CheekRight
            } else {
                HitZone::NoseCenter
            }
        } else if hx < -56.0 {
            HitZone::ShoulderLeft
        } else if hx > 56.0 {
            HitZone::ShoulderRight
        } else {
            HitZone::TorsoBelly
        };

        // Tính điểm chạm chuẩn trên bộ phận (kẹp hợp lý nếu người dùng click ở khoảng trống xa ngoài biên)
        let (tx, ty, orig_x, orig_y, kind) = match zone {
            HitZone::HeadTop => {
                let tx = cur_hx + hx.clamp(-46.0, 46.0) * s;
                let ty = cur_hy - 68.0 * s;
                let tilt_x = (self.rng.next() - 0.5) * 44.0 * s;
                (tx, ty, tx + tilt_x, ty - 235.0 * s, 1.0)
            }
            HitZone::CheekLeft => {
                let tx = cur_hx - (64.0 + self.rng.next() * 14.0) * s;
                let ty = cur_hy + hy.clamp(-18.0, 42.0) * s;
                (tx, ty, tx - 245.0 * s, ty + (18.0 + self.rng.next() * 32.0) * s, 0.0)
            }
            HitZone::CheekRight => {
                let tx = cur_hx + (64.0 + self.rng.next() * 14.0) * s;
                let ty = cur_hy + hy.clamp(-18.0, 42.0) * s;
                (tx, ty, tx + 245.0 * s, ty + (18.0 + self.rng.next() * 32.0) * s, 0.0)
            }
            HitZone::NoseCenter => {
                let tx = cur_hx + hx.clamp(-18.0, 18.0) * s;
                let ty = cur_hy + hy.clamp(-8.0, 28.0) * s;
                let side = if self.rng.next() < 0.5 { -1.0 } else { 1.0 };
                (tx, ty, tx + side * 65.0 * s, ty + 165.0 * s, 2.0)
            }
            HitZone::ShoulderLeft => {
                let tx = base_torso.0 - 88.0 * s;
                let ty = base_torso.1 - 12.0 * s;
                (tx, ty, tx - 235.0 * s, ty - 25.0 * s, 0.0)
            }
            HitZone::ShoulderRight => {
                let tx = base_torso.0 + 88.0 * s;
                let ty = base_torso.1 - 12.0 * s;
                (tx, ty, tx + 235.0 * s, ty - 25.0 * s, 0.0)
            }
            HitZone::TorsoBelly => {
                let tx = base_torso.0 + hx.clamp(-36.0, 36.0) * s;
                let ty = base_torso.1 + 12.0 * s;
                let side = if self.rng.next() < 0.5 { -1.0 } else { 1.0 };
                (tx, ty, tx + side * 185.0 * s, ty + 115.0 * s, 0.0)
            }
            HitZone::Mug => unreachable!(),
        };

        let dir = (ty - orig_y).atan2(tx - orig_x);
        let slot = self.next_punch_slot % self.punches.len();
        self.next_punch_slot = self.next_punch_slot.wrapping_add(1);
        self.punches[slot] = PunchSlot {
            active: true,
            zone,
            orig_x,
            orig_y,
            tx,
            ty,
            dir,
            kind,
            age: 0.0,
            hit_applied: false,
        };
        self.interact_until = now + 2_300.0;
    }

    /// Áp dụng xung lực đàn hồi (Squash & Stretch) ngay khoảnh khắc găng Boxing chạm vào bộ phận!
    fn apply_zone_impact(&mut self, zone: HitZone, tx: f32, ty: f32) {
        let bounce = self.p.bounciness;
        let power = self.p.punch_power;
        let k = (bounce * power).sqrt();

        self.spawn_puff(tx, ty);

        if zone == HitZone::Mug {
            self.mug_hop_vy = 280.0 * power;
            self.mug_tilt.kick((if self.rng.next() < 0.5 { -1.0 } else { 1.0 }) * 14.0 * bounce);
            self.smile_boost = 1.0;
            return;
        }

        if self.last_hit_gap < 0.80 {
            self.combo_count = (self.combo_count + 1).min(99);
        } else {
            self.combo_count = 1;
        }
        self.last_hit_gap = 0.0;

        self.wince_timer = 0.42;
        self.smile_boost = 1.0;
        if self.combo_count >= 4 {
            self.dizzy_timer = 1.35;
        }

        match zone {
            HitZone::HeadTop => {
                // Đấm búa từ đỉnh đầu xuống giống ảnh GIF mẫu: đầu bẹp dẹt, hai má phình ngang cực đã!
                self.head_squash.kick(-14.2 * bounce);
                self.head_y.kick(980.0 * power);
                self.head_rot.kick((self.rng.next() - 0.5) * 6.5 * bounce);
                self.face_dent = (0.0, -68.0);
                self.face_push_y.kick(680.0 * k);
                self.glass_y.kick(380.0 * bounce);
                self.glass_rot.kick((self.rng.next() - 0.5) * 14.0 * bounce);
                self.hair_whip.kick((if self.rng.next() < 0.5 { -1.0 } else { 1.0 }) * 16.0 * bounce);
                self.torso_squash.kick(-7.8 * bounce);
                self.torso_y.kick(360.0 * power);
                self.arm_l.kick(420.0 * k);
                self.arm_r.kick(420.0 * k);
                self.desk_shake.kick(145.0 * power);
                self.mug_hop_vy = self.mug_hop_vy.max(225.0 * power);
                self.mug_tilt.kick(9.5 * power);
            }
            HitZone::CheekLeft => {
                // Móc trái: má trái lõm vào, má phải phình dạt sang phải, kính lệch hẳn một bên!
                self.face_dent = (-68.0, 12.0);
                self.face_push_x.kick(1080.0 * k);
                self.face_push_y.kick(-140.0 * k);
                self.head_x.kick(1050.0 * power);
                self.head_y.kick(-120.0 * power);
                self.head_rot.kick(11.2 * bounce);
                self.head_squash.kick(-4.8 * bounce);
                self.glass_x.kick(310.0 * bounce);
                self.glass_rot.kick(16.5 * bounce);
                self.hair_whip.kick(22.0 * bounce);
                self.torso_shear.kick(6.8 * bounce);
                self.torso_x.kick(290.0 * power);
                self.necklace_ang.kick(14.5 * power);
            }
            HitZone::CheekRight => {
                // Móc phải: mặt dạt sang trái, kính lệch chéo ngược lại!
                self.face_dent = (68.0, 12.0);
                self.face_push_x.kick(-1080.0 * k);
                self.face_push_y.kick(-140.0 * k);
                self.head_x.kick(-1050.0 * power);
                self.head_y.kick(-120.0 * power);
                self.head_rot.kick(-11.2 * bounce);
                self.head_squash.kick(-4.8 * bounce);
                self.glass_x.kick(-310.0 * bounce);
                self.glass_rot.kick(-16.5 * bounce);
                self.hair_whip.kick(-22.0 * bounce);
                self.torso_shear.kick(-6.8 * bounce);
                self.torso_x.kick(-290.0 * power);
                self.necklace_ang.kick(-14.5 * power);
            }
            HitZone::NoseCenter => {
                // Đấm thẳng giữa mặt / kính: mặt co tròn phình hai má, kính nảy lệch hài hước!
                let sgn = if self.rng.next() < 0.5 { -1.0 } else { 1.0 };
                self.face_dent = (0.0, 8.0);
                self.face_push_y.kick(-640.0 * k);
                self.face_push_x.kick(sgn * 320.0 * k);
                self.head_squash.kick(-10.5 * bounce);
                self.head_y.kick(-420.0 * power);
                self.head_rot.kick(sgn * 7.2 * bounce);
                self.glass_y.kick(-280.0 * bounce);
                self.glass_rot.kick(-sgn * 18.0 * bounce);
                self.hair_whip.kick(sgn * 14.0 * bounce);
                self.necklace_ang.kick(sgn * 10.0 * power);
            }
            HitZone::ShoulderLeft => {
                // Tạt vai trái: vai trái sụp xuống, thân vặn nghiêng, dây chuyền văng mạnh
                self.arm_l.kick(680.0 * k);
                self.torso_shear.kick(9.5 * bounce);
                self.torso_x.kick(480.0 * power);
                self.torso_squash.kick(-4.2 * bounce);
                self.head_x.kick(420.0 * power);
                self.head_rot.kick(-8.2 * bounce);
                self.glass_rot.kick(-10.5 * bounce);
                self.necklace_ang.kick(18.5 * power);
                self.desk_shake.kick(90.0 * power);
            }
            HitZone::ShoulderRight => {
                // Tạt vai phải
                self.arm_r.kick(680.0 * k);
                self.torso_shear.kick(-9.5 * bounce);
                self.torso_x.kick(-480.0 * power);
                self.torso_squash.kick(-4.2 * bounce);
                self.head_x.kick(-420.0 * power);
                self.head_rot.kick(8.2 * bounce);
                self.glass_rot.kick(10.5 * bounce);
                self.necklace_ang.kick(-18.5 * power);
                self.desk_shake.kick(90.0 * power);
            }
            HitZone::TorsoBelly => {
                // Đấm thân áo đen: ngực/bụng lõm cong, hai vai chồm tới, bàn rung nảy cốc dưa hấu!
                self.body_dent.kick(760.0 * k);
                self.torso_squash.kick(-9.5 * bounce);
                self.torso_y.kick(440.0 * power);
                self.head_y.kick(580.0 * power);
                self.head_squash.kick(5.6 * bounce);
                self.arm_l.kick(340.0 * k);
                self.arm_r.kick(340.0 * k);
                self.necklace_ang.kick((self.rng.next() - 0.5) * 22.0 * power);
                self.desk_shake.kick(190.0 * power);
                self.mug_hop_vy = self.mug_hop_vy.max(275.0 * power);
                self.mug_tilt.kick((if self.rng.next() < 0.5 { -1.0 } else { 1.0 }) * 14.0 * power);
            }
            HitZone::Mug => {}
        }
    }

    fn step(&mut self, dt: f32, now: f64) {
        let dt = dt.min(0.06);
        self.anim_t += dt;
        self.last_hit_gap += dt;
        if self.last_hit_gap > 1.4 {
            self.combo_count = 0;
        }

        // Chế độ tự động đấm lặp liên hoàn như GIF (khi người dùng bật autoPunch = 1 hoặc 2)
        let auto_mode = self.p.auto_punch.round() as i32;
        if auto_mode > 0 {
            self.auto_cd -= dt;
            if self.auto_cd <= 0.0 {
                let (s, _, base_head, base_torso) = self.anchors();
                let pick = (self.rng.next() * 6.0) as i32;
                let (ax, ay) = match pick {
                    0 | 1 => (base_head.0, base_head.1 - 75.0 * s), // Ưu tiên đấm búa đỉnh đầu như GIF mẫu!
                    2 => (base_head.0 - 72.0 * s, base_head.1 + 10.0 * s),
                    3 => (base_head.0 + 72.0 * s, base_head.1 + 10.0 * s),
                    4 => (base_head.0, base_head.1 + 8.0 * s),
                    _ => (base_torso.0, base_torso.1 + 10.0 * s),
                };
                self.launch_punch_at(ax, ay, now);
                self.auto_cd = if auto_mode >= 2 {
                    0.38 + self.rng.next() * 0.20
                } else {
                    1.25 + self.rng.next() * 0.55
                };
            }
        }

        // Cập nhật các găng tay đang bay & kích hoạt va chạm đúng thời điểm chạm đích (0.075s)
        let mut hit_events: Vec<(HitZone, f32, f32)> = Vec::new();
        for p in &mut self.punches {
            if !p.active {
                continue;
            }
            p.age += dt;
            if !p.hit_applied && p.age >= 0.075 {
                p.hit_applied = true;
                hit_events.push((p.zone, p.tx, p.ty));
            }
            if p.age >= 0.36 {
                p.active = false;
            }
        }
        for (z, tx, ty) in hit_events {
            self.apply_zone_impact(z, tx, ty);
        }

        // Cập nhật chùm khói Puff hoạt hình
        for pf in &mut self.puffs {
            if pf.active {
                pf.age += dt * 1.65;
                if pf.age >= 1.0 {
                    pf.active = false;
                }
            }
        }

        // Độ giảm chấn phụ thuộc thông số `bounciness` (càng cao càng nảy lâu như thạch mochi!)
        let zeta_main = (0.30 / self.p.bounciness.sqrt()).clamp(0.14, 0.42);
        let zeta_loose = (zeta_main * 0.72).clamp(0.10, 0.34);

        self.head_x.step(dt, 21.0, zeta_main, 62.0);
        self.head_y.step(dt, 23.0, zeta_main, 56.0);
        self.head_rot.step(dt, 19.5, zeta_main, 0.48);
        self.head_squash.step(dt, 25.0, zeta_main, 0.50);

        self.face_push_x.step(dt, 26.0, zeta_main, 46.0);
        self.face_push_y.step(dt, 26.0, zeta_main, 42.0);

        // Kính có tần số riêng thấp hơn & ít cản hơn -> lắc lệch pha cực kỳ hài hước!
        self.glass_x.step(dt, 16.5, zeta_loose, 22.0);
        self.glass_y.step(dt, 17.5, zeta_loose, 24.0);
        self.glass_rot.step(dt, 15.5, zeta_loose, 0.44);
        self.hair_whip.step(dt, 18.0, zeta_loose, 2.2);

        self.torso_x.step(dt, 20.0, zeta_main, 38.0);
        self.torso_y.step(dt, 22.0, zeta_main, 32.0);
        self.torso_shear.step(dt, 18.5, zeta_main, 0.42);
        self.torso_squash.step(dt, 23.5, zeta_main, 0.36);

        self.arm_l.step(dt, 20.0, zeta_loose, 36.0);
        self.arm_r.step(dt, 20.0, zeta_loose, 36.0);
        self.necklace_ang.step(dt, 13.5, 0.12, 0.85);
        self.body_dent.step(dt, 24.0, zeta_main, 34.0);
        self.desk_shake.step(dt, 34.0, 0.28, 12.0);

        // Trọng lực nảy chiếc cốc sứ dưa hấu trên mặt bàn
        if self.mug_hop_y > 0.0 || self.mug_hop_vy != 0.0 {
            self.mug_hop_y += self.mug_hop_vy * dt;
            self.mug_hop_vy -= 680.0 * dt;
            if self.mug_hop_y <= 0.0 {
                self.mug_hop_y = 0.0;
                if self.mug_hop_vy < -45.0 {
                    self.mug_hop_vy = -self.mug_hop_vy * 0.42;
                } else {
                    self.mug_hop_vy = 0.0;
                }
            }
        }
        self.mug_tilt.step(dt, 22.0, 0.20, 0.35);

        // Biểu cảm mắt nháy tự nhiên & hiệu ứng cười/choáng
        self.wince_timer = (self.wince_timer - dt).max(0.0);
        self.dizzy_timer = (self.dizzy_timer - dt).max(0.0);
        self.smile_boost = (self.smile_boost - dt * 1.4).max(0.0);

        self.blink_cd -= dt;
        if self.blink_cd <= 0.0 {
            self.blink_prog += dt * 7.5;
            if self.blink_prog >= PI {
                self.blink_prog = 0.0;
                self.blink_cd = 2.6 + self.rng.next() * 2.4;
            }
        }
    }

    fn draw(&mut self, gl: &glow::Context, sh: &mut Shared, now: f64) {
        let t = ((now - self.t0) / 1000.0) as f32;
        // Nhịp thở & lắc đầu thư giãn siêu nhẹ khi ngồi mỉm cười
        let idle_bob = (t * 2.1).sin() * 2.2;
        let idle_tilt = (t * 1.3).sin() * 0.018;

        let combo_glow = if self.dizzy_timer > 0.0 {
            (self.dizzy_timer / 0.45).clamp(0.0, 1.0)
        } else {
            0.0
        };

        let style_u = [
            self.p.glove_style.round(),
            self.p.backdrop.round(),
            combo_glow,
            self.desk_shake.pos,
        ];
        let head_u = [
            self.head_x.pos,
            self.head_y.pos + idle_bob,
            self.head_rot.pos + idle_tilt,
            self.head_squash.pos,
        ];
        let face_u = [
            self.face_dent.0,
            self.face_dent.1,
            self.face_push_x.pos,
            self.face_push_y.pos,
        ];
        let glasses_u = [
            self.glass_x.pos,
            self.glass_y.pos,
            self.glass_rot.pos,
            self.hair_whip.pos + (t * 1.7).cos() * 0.08,
        ];
        let torso_u = [
            self.torso_x.pos,
            self.torso_y.pos + idle_bob * 0.45,
            self.torso_shear.pos,
            self.torso_squash.pos,
        ];
        let rig2_u = [
            self.arm_l.pos,
            self.arm_r.pos,
            self.necklace_ang.pos + (t * 1.5).sin() * 0.025,
            self.body_dent.pos,
        ];
        let expr_u = [
            self.blink_prog.sin().max(0.0),
            (self.wince_timer * 4.0).clamp(0.0, 1.0),
            (self.dizzy_timer * 3.0).clamp(0.0, 1.0),
            self.smile_boost,
        ];
        let props_u = [
            self.mug_hop_y,
            self.mug_tilt.pos,
            if self.wince_timer > 0.25 { 1.0 } else { 0.0 },
            self.combo_count as f32,
        ];

        let mut gloves_u = [0f32; 16];
        let mut glove_meta_u = [0f32; 16];
        for (i, slot) in self.punches.iter().enumerate() {
            if !slot.active {
                continue;
            }
            // 0..0.075s: lao cực nhanh tới mục tiêu; 0.075..0.13s: găm lực nén; 0.13..0.36s: thu tay về & mờ dần
            let (prog, alpha_sc, phase) = if slot.age < 0.075 {
                let u = slot.age / 0.075;
                let ease = 1.0 - (1.0 - u) * (1.0 - u);
                let sc = if slot.kind > 1.5 { 0.65 + 0.55 * ease } else { 1.05 };
                (ease, sc, u)
            } else if slot.age < 0.135 {
                let u = (slot.age - 0.075) / 0.060;
                let sc = if slot.kind > 1.5 { 1.25 - 0.10 * u } else { 1.16 - 0.08 * u };
                (1.0 + 0.05 * (1.0 - u), sc, 1.0)
            } else {
                let u = ((slot.age - 0.135) / 0.225).clamp(0.0, 1.0);
                let pos_t = 1.0 - u * 0.68;
                let fade = (1.0 - u) * 1.05;
                (pos_t, fade, 1.2 + u)
            };

            let gx = slot.orig_x + (slot.tx - slot.orig_x) * prog;
            let gy = slot.orig_y + (slot.ty - slot.orig_y) * prog;
            gloves_u[i * 4..i * 4 + 4].copy_from_slice(&[gx, gy, slot.dir, alpha_sc]);
            glove_meta_u[i * 4..i * 4 + 4].copy_from_slice(&[slot.orig_x, slot.orig_y, phase, slot.kind]);
        }

        let mut puffs_u = [0f32; 24];
        for (i, pf) in self.puffs.iter().enumerate() {
            if pf.active {
                puffs_u[i * 4..i * 4 + 4].copy_from_slice(&[pf.x, pf.y, pf.age, pf.seed]);
            }
        }

        let p = &mut sh.prog;
        unsafe { gl.use_program(Some(p.prog)) };
        self.b.bind_common(gl, p, sh.noise_tex, sh.seed, t);
        p.f4v(gl, "uStyle", &style_u);
        p.f4v(gl, "uHeadDef", &head_u);
        p.f4v(gl, "uFaceWarp", &face_u);
        p.f4v(gl, "uGlasses", &glasses_u);
        p.f4v(gl, "uTorsoDef", &torso_u);
        p.f4v(gl, "uRig2", &rig2_u);
        p.f4v(gl, "uExpr", &expr_u);
        p.f4v(gl, "uProps", &props_u);
        p.f4v(gl, "uGloves", &gloves_u);
        p.f4v(gl, "uGloveMeta", &glove_meta_u);
        p.f4v(gl, "uPuffs", &puffs_u);
        unsafe { gl.draw_arrays(glow::TRIANGLES, 0, 3) };
    }
}

impl Theme for GymoBoxing {
    fn set_icons(&mut self, _gl: &glow::Context, icons: Vec<IconBox>, _first: bool, _now: f64) {
        self.b.icons = icons;
    }

    fn frame(&mut self, gl: &glow::Context, sh: &mut Shared, dt: f32, now: f64) {
        self.step(dt, now);
        self.draw(gl, sh, now);
    }

    fn settle(&mut self, gl: &glow::Context, sh: &mut Shared, now: f64) {
        self.draw(gl, sh, now);
    }

    fn handle_click(&mut self, _gl: &glow::Context, x: f32, y: f32, now: f64) {
        self.launch_punch_at(x, y, now);
    }

    fn is_interacting(&self, now: f64) -> bool {
        // Chỉ bật 50 FPS khi đang có cú đấm / dao động lò xo biến dạng; lúc nghỉ giữ đúng 20 FPS siêu nhẹ!
        now < self.interact_until || self.p.auto_punch.round() >= 2.0
    }

    fn destroy(&mut self, gl: &glow::Context) {
        self.b.destroy(gl);
    }

    fn field_ms(&self) -> f64 {
        0.0
    }
}
