//! Chủ đề Võ đài quyền anh (prototype/boxing-ring.html): phòng tập & võ đài quyền anh Arcade góc nhìn 3/4,
//! hai võ sĩ đối kháng kết hợp hệ lò xo giảm chấn Squash & Stretch, phóng găng tay đa vùng, khói tròn puff,
//! sao choáng combo, thanh máu HUD Arcade và đạo cụ phòng gym tương tác.
//! Shader dùng chung một nguồn duy nhất: prototype/boxing-ring.frag.

use crate::engine::*;
use std::f32::consts::PI;

pub const FRAG: &str = include_str!("../../../prototype/boxing-ring.frag");

pub struct Params {
    pub bounciness: f32,
    pub punch_power: f32,
    pub auto_spar: i32,
    pub glove_style: i32,
    pub hud_mode: i32,
    pub sigma: f32,
    pub warp: f32,
}

impl Params {
    pub fn from_json(v: Option<&serde_json::Value>) -> Self {
        let g = |k: &str, d: f32| v.and_then(|o| o.get(k)).and_then(|x| x.as_f64()).map(|x| x as f32).unwrap_or(d);
        Params {
            bounciness: g("bounciness", 1.25).clamp(0.4, 2.5),
            punch_power: g("punchPower", 1.0).clamp(0.5, 2.5),
            auto_spar: (g("autoSpar", 0.0).round() as i32).clamp(0, 2),
            glove_style: (g("gloveStyle", 0.0).round() as i32).clamp(0, 2),
            hud_mode: (g("hudMode", 0.0).round() as i32).clamp(0, 2),
            sigma: g("sigma", 74.0).clamp(40.0, 160.0),
            warp: g("warp", 22.0).clamp(0.0, 60.0),
        }
    }
}

#[derive(Clone, Copy)]
struct Spring {
    x: f32,
    v: f32,
    k: f32,
    c: f32,
}

impl Spring {
    fn new(k: f32, c: f32) -> Self {
        Self { x: 0.0, v: 0.0, k, c }
    }

    fn step(&mut self, dt: f32, target: f32) {
        let a = (target - self.x) * self.k - self.v * self.c;
        self.v += a * dt;
        self.x += self.v * dt;
    }

    fn impulse(&mut self, dv: f32) {
        self.v += dv;
    }
}

#[derive(Clone, Copy)]
enum HitZone {
    HeadTop,
    CheekHook,
    ChinJab,
    BodyShot,
    Bag(u8),
}

impl HitZone {
    fn glove_kind(self) -> f32 {
        match self {
            HitZone::HeadTop => 1.0,
            HitZone::ChinJab => 2.0,
            HitZone::CheekHook | HitZone::BodyShot | HitZone::Bag(_) => 0.0,
        }
    }
}

#[derive(Clone, Copy)]
struct FighterRig {
    head_x: Spring,
    head_y: Spring,
    head_rot: Spring,
    head_squash: Spring,
    face_push_x: Spring,
    face_push_y: Spring,
    dent_x: f32,
    dent_y: f32,
    torso_shear: Spring,
    torso_squash: Spring,
    body_dent: Spring,
    lunge_x: Spring,
    punch_ext: f32,
    weave_ph: f32,
    blink_cd: f32,
    blink_prog: f32,
    wince_timer: f32,
    dizzy_timer: f32,
    hit_flash: f32,
    hp: f32,
    hp_lag: f32,
    lag_hold: f32,
    combo_hits: u32,
    combo_window: f32,
}

impl FighterRig {
    fn new(phase_offset: f32, blink_wait: f32) -> Self {
        Self {
            head_x: Spring::new(125.0, 5.6),
            head_y: Spring::new(132.0, 5.8),
            head_rot: Spring::new(118.0, 5.2),
            head_squash: Spring::new(138.0, 4.9),
            face_push_x: Spring::new(135.0, 5.8),
            face_push_y: Spring::new(135.0, 5.8),
            dent_x: 10.0,
            dent_y: 0.0,
            torso_shear: Spring::new(115.0, 5.8),
            torso_squash: Spring::new(128.0, 5.8),
            body_dent: Spring::new(118.0, 5.4),
            lunge_x: Spring::new(62.0, 6.4),
            punch_ext: 0.0,
            weave_ph: phase_offset,
            blink_cd: blink_wait,
            blink_prog: -1.0,
            wince_timer: 0.0,
            dizzy_timer: 0.0,
            hit_flash: 0.0,
            hp: 1.0,
            hp_lag: 1.0,
            lag_hold: 0.0,
            combo_hits: 0,
            combo_window: 0.0,
        }
    }

    fn tune_bounciness(&mut self, bounciness: f32) {
        let damp_scale = (1.35 / bounciness.clamp(0.4, 2.5).sqrt()).clamp(0.60, 1.85);
        self.head_x.c = 5.6 * damp_scale;
        self.head_y.c = 5.8 * damp_scale;
        self.head_rot.c = 5.2 * damp_scale;
        self.head_squash.c = 4.9 * damp_scale;
        self.face_push_x.c = 5.8 * damp_scale;
        self.face_push_y.c = 5.8 * damp_scale;
        self.torso_shear.c = 5.8 * damp_scale;
        self.torso_squash.c = 5.8 * damp_scale;
        self.body_dent.c = 5.4 * damp_scale;
    }

    fn step_springs(&mut self, sub_dt: f32) {
        self.head_x.step(sub_dt, 0.0);
        self.head_y.step(sub_dt, 0.0);
        self.head_rot.step(sub_dt, 0.0);
        self.head_squash.step(sub_dt, 0.0);
        self.face_push_x.step(sub_dt, 0.0);
        self.face_push_y.step(sub_dt, 0.0);
        self.torso_shear.step(sub_dt, 0.0);
        self.torso_squash.step(sub_dt, 0.0);
        self.body_dent.step(sub_dt, 0.0);
        self.lunge_x.step(sub_dt, 0.0);
        self.lunge_x.x = self.lunge_x.x.clamp(-145.0, 145.0);
        self.body_dent.x = self.body_dent.x.clamp(-0.35, 1.35);
    }
}

#[derive(Clone, Copy)]
struct PunchSlot {
    active: bool,
    age: f32,
    impacted: bool,
    attacker: Option<usize>,
    target: Option<usize>,
    zone: HitZone,
    orig_x: f32,
    orig_y: f32,
    tx: f32,
    ty: f32,
    dir: f32,
    peak_scale: f32,
    power_mul: f32,
}

impl Default for PunchSlot {
    fn default() -> Self {
        Self {
            active: false,
            age: 0.0,
            impacted: false,
            attacker: None,
            target: None,
            zone: HitZone::CheekHook,
            orig_x: 0.0,
            orig_y: 0.0,
            tx: 0.0,
            ty: 0.0,
            dir: 0.0,
            peak_scale: 0.92,
            power_mul: 1.0,
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

pub struct BoxingRing {
    b: Base,
    p: Params,
    rng: Rng,
    fighters: [FighterRig; 2],
    punches: [PunchSlot; 4],
    next_punch_slot: usize,
    puffs: [PuffBurst; 6],
    next_puff_slot: usize,
    bag_red: Spring,
    bag_dark_l: Spring,
    bag_right: Spring,
    tire_smash: f32,
    ring_shake: Spring,
    rope_vib: f32,
    round_num: u8,
    round_sec: f32,
    bell_flash: f32,
    combo_glow: f32,
    spar_cd: f32,
    user_active_timer: f32,
    t0: f64,
}

impl BoxingRing {
    pub fn new(gl: &glow::Context, w: f32, h: f32, buf_w: i32, buf_h: i32, scale: f32, seed: i32, p: Params, rng_seed: u64, now: f64) -> Self {
        let mut rng = Rng::new(rng_seed);
        let mut f0 = FighterRig::new(0.2, 2.2 + rng.next() * 2.5);
        let mut f1 = FighterRig::new(2.3, 1.6 + rng.next() * 2.8);
        f0.tune_bounciness(p.bounciness);
        f1.tune_bounciness(p.bounciness);

        let spar_cd = match p.auto_spar {
            2 => 0.35,
            0 => 4.35, // Để 4 giây đầu ổn định tư thế thủ đẹp cho ảnh chụp kiểm tra / thumbnail
            _ => 9999.0,
        };

        let mut s = Self {
            b: Base::new(gl, w, h, buf_w, buf_h, scale, seed),
            p,
            rng,
            fighters: [f0, f1],
            punches: [PunchSlot::default(); 4],
            next_punch_slot: 0,
            puffs: [PuffBurst::default(); 6],
            next_puff_slot: 0,
            bag_red: Spring::new(24.0, 1.85),
            bag_dark_l: Spring::new(21.0, 1.75),
            bag_right: Spring::new(20.0, 1.75),
            tire_smash: 0.0,
            ring_shake: Spring::new(240.0, 14.0),
            rope_vib: 0.0,
            round_num: 1,
            round_sec: 60.0,
            bell_flash: 0.0,
            combo_glow: 0.0,
            spar_cd,
            user_active_timer: 0.0,
            t0: now,
        };
        s.b.commit(gl, &[], s.p.sigma, s.p.warp, true, now);
        s
    }

    fn scene_metrics(&self) -> (f32, f32, f32, f32) {
        let w = self.b.w;
        let avail_h = (self.b.h - 48.0).max(280.0);
        let s = (w / 1080.0).min(avail_h / 640.0);
        (w, avail_h, s, w * 0.5)
    }

    fn fighter_base_foot(&self, idx: usize) -> (f32, f32, f32) {
        let (_w, avail_h, s, cx) = self.scene_metrics();
        let f = &self.fighters[idx];
        let facing = if idx == 0 { 1.0 } else { -1.0 };
        let weave_x = (f.weave_ph * 0.85).sin() * 7.5;
        let bob_y = (f.weave_ph * 1.7).sin().abs() * 4.2 - 2.0;
        let base_x = cx - facing * 68.0 * s + weave_x * s;
        let base_y = avail_h * if idx == 0 { 0.758 } else { 0.766 };
        (base_x, base_y, bob_y)
    }

    fn spawn_puff(&mut self, x: f32, y: f32) {
        let slot = self.next_puff_slot % self.puffs.len();
        self.next_puff_slot = self.next_puff_slot.wrapping_add(1);
        let seed = 0.08 + self.rng.next() * 0.90;
        self.puffs[slot] = PuffBurst {
            active: true,
            x,
            y,
            age: 0.0,
            seed,
        };
    }

    fn launch_fighter_punch(&mut self, attacker: usize, target: usize, zone: HitZone, click_pos: Option<(f32, f32)>, power_mul: f32) {
        let (_w, _avail_h, s, _cx) = self.scene_metrics();
        let facing_att = if attacker == 0 { 1.0 } else { -1.0 };
        let (att_bx, att_by, _) = self.fighter_base_foot(attacker);
        let att_fx = att_bx + self.fighters[attacker].lunge_x.x * s;

        let (tgt_bx, tgt_by, _) = self.fighter_base_foot(target);
        let tgt_fx = tgt_bx + self.fighters[target].lunge_x.x * s;
        let head_cx = tgt_fx + self.fighters[target].head_x.x * s;
        let head_cy = tgt_by - 115.0 * s + self.fighters[target].head_y.x * s;
        let torso_cy = tgt_by - 66.0 * s;

        let (tx, ty, orig_x, orig_y) = match zone {
            HitZone::HeadTop => {
                let tx = click_pos.map(|c| c.0.clamp(head_cx - 24.0 * s, head_cx + 24.0 * s)).unwrap_or(head_cx);
                let ty = head_cy - 18.0 * s;
                (tx, ty, tx - facing_att * 72.0 * s, ty - 148.0 * s)
            }
            HitZone::CheekHook => {
                let tx = head_cx - facing_att * 12.0 * s;
                let ty = click_pos.map(|c| c.1.clamp(head_cy - 14.0 * s, head_cy + 14.0 * s)).unwrap_or(head_cy - 2.0 * s);
                (tx, ty, att_fx - facing_att * 38.0 * s, ty + 26.0 * s)
            }
            HitZone::ChinJab => {
                let tx = head_cx - facing_att * 10.0 * s;
                let ty = head_cy + 8.0 * s;
                (tx, ty, att_fx + facing_att * 8.0 * s, att_by - 78.0 * s)
            }
            HitZone::BodyShot | HitZone::Bag(_) => {
                let tx = tgt_fx - facing_att * 14.0 * s;
                let ty = click_pos.map(|c| c.1.clamp(torso_cy - 16.0 * s, torso_cy + 20.0 * s)).unwrap_or(torso_cy);
                (tx, ty, att_fx - facing_att * 24.0 * s, torso_cy + 34.0 * s)
            }
        };

        // Võ sĩ tung đòn bước nhích tới và vươn tay sau ra
        self.fighters[attacker].punch_ext = 1.0;
        self.fighters[attacker].lunge_x.impulse(facing_att * 135.0 * power_mul);
        self.fighters[attacker].torso_shear.impulse(-facing_att * 3.8 * power_mul);

        let dir = (ty - orig_y).atan2(tx - orig_x);
        let slot = self.next_punch_slot % self.punches.len();
        self.next_punch_slot = self.next_punch_slot.wrapping_add(1);
        self.punches[slot] = PunchSlot {
            active: true,
            age: 0.0,
            impacted: false,
            attacker: Some(attacker),
            target: Some(target),
            zone,
            orig_x,
            orig_y,
            tx,
            ty,
            dir,
            peak_scale: (0.86 + 0.12 * self.p.punch_power.min(1.6)) * power_mul.sqrt(),
            power_mul,
        };
    }

    fn apply_impact(&mut self, slot: PunchSlot) {
        let (_w, _avail_h, s, _cx) = self.scene_metrics();
        let power = self.p.punch_power * slot.power_mul;
        let bounce = self.p.bounciness;

        self.spawn_puff(slot.tx, slot.ty);

        match slot.zone {
            HitZone::Bag(bag_id) => {
                let dir_sign = if slot.dir.cos() >= 0.0 { 1.0 } else { -1.0 };
                match bag_id {
                    0 => self.bag_red.impulse(dir_sign * 3.4 * power),
                    1 => self.bag_dark_l.impulse(dir_sign * 3.2 * power),
                    _ => self.bag_right.impulse(dir_sign * 3.2 * power),
                }
                return;
            }
            _ => {}
        }

        let Some(target) = slot.target else { return };
        let facing_tgt = if target == 0 { 1.0 } else { -1.0 };
        // Hướng đòn bay tới (ngược hướng mặt của võ sĩ trúng đòn)
        let push_dir = -facing_tgt;

        {
            let f = &mut self.fighters[target];
            f.wince_timer = 0.85;
            f.hit_flash = 1.0;

            if f.combo_window > 0.0 {
                f.combo_hits = f.combo_hits.saturating_add(1);
            } else {
                f.combo_hits = 1;
            }
            f.combo_window = 1.15;

            match slot.zone {
                HitZone::HeadTop => {
                    // Đấm búa từ đỉnh đầu: nén bẹp dọc như bánh mochi, má phình ngang, chân nhún sâu
                    f.head_y.impulse(340.0 * power);
                    f.head_squash.impulse(-9.2 * bounce * power.sqrt());
                    f.torso_squash.impulse(-4.8 * bounce * power.sqrt());
                    f.dent_x = 0.0;
                    f.dent_y = -18.0;
                    f.face_push_y.impulse(280.0 * bounce);
                    f.lunge_x.impulse(push_dir * 75.0 * power);
                }
                HitZone::CheekHook => {
                    // Đấm móc ngang: mặt lõm lệch bất đối xứng, cổ xoay lắc lò xo mạnh
                    f.head_x.impulse(push_dir * 420.0 * power);
                    f.head_rot.impulse(push_dir * 11.5 * power);
                    f.head_squash.impulse(-4.2 * bounce);
                    f.dent_x = facing_tgt * 15.0;
                    f.dent_y = 2.0;
                    f.face_push_x.impulse(push_dir * 320.0 * bounce * power.sqrt());
                    f.torso_shear.impulse(-push_dir * 5.2 * power);
                    f.lunge_x.impulse(push_dir * 185.0 * power);
                }
                HitZone::ChinJab => {
                    // Đấm thẳng / móc cằm: đầu ngửa bật lên & ra sau, kéo giãn dọc rồi nảy về
                    f.head_x.impulse(push_dir * 330.0 * power);
                    f.head_y.impulse(-240.0 * power);
                    f.head_rot.impulse(push_dir * 9.5 * power);
                    f.head_squash.impulse(6.5 * bounce * power.sqrt());
                    f.dent_x = facing_tgt * 14.0;
                    f.dent_y = 8.0;
                    f.face_push_x.impulse(push_dir * 260.0 * bounce);
                    f.face_push_y.impulse(-160.0 * bounce);
                    f.lunge_x.impulse(push_dir * 155.0 * power);
                }
                HitZone::BodyShot | HitZone::Bag(_) => {
                    // Đấm móc sườn: thân người uốn cong chữ C, vai gập chồm tới, rung dây đài mạnh
                    f.body_dent.impulse(14.5 * bounce * power.sqrt());
                    f.torso_shear.impulse(-facing_tgt * 8.5 * power);
                    f.torso_squash.impulse(-4.5 * bounce);
                    f.head_y.impulse(165.0 * power);
                    f.head_rot.impulse(-push_dir * 5.2 * power);
                    f.lunge_x.impulse(push_dir * 220.0 * power);
                }
            }

            // Trừ thanh máu HUD + giữ vạch vàng tụt trễ kiểu Street Fighter
            let dmg = (0.075 * power).clamp(0.03, 0.22);
            f.hp = (f.hp - dmg).max(0.0);
            f.lag_hold = 0.45;

            if f.combo_hits >= 4 || f.hp <= 0.01 {
                f.dizzy_timer = 1.45;
                f.lunge_x.impulse(push_dir * 140.0);
                self.combo_glow = 1.0;
            }
        }

        // Chấn động sàn đài & rung bần bật 3 tầng dây thừng
        let rope_kick = match slot.zone {
            HitZone::BodyShot => 5.2,
            HitZone::HeadTop => 4.2,
            _ => 3.2,
        };
        self.rope_vib = (self.rope_vib + rope_kick * power).min(7.5);
        self.ring_shake.impulse(95.0 * power);

        // Nếu bị dồn sát góc đài thì dây thừng nảy bật ngược trở lại
        let pushed_x = self.fighters[target].lunge_x.x;
        if pushed_x.abs() > 95.0 {
            self.rope_vib = (self.rope_vib + 2.8).min(8.0);
            let (_, tgt_by, _) = self.fighter_base_foot(target);
            let (tgt_bx, _, _) = self.fighter_base_foot(target);
            self.spawn_puff(tgt_bx + pushed_x * s, tgt_by - 58.0 * s);
        }
    }

    fn trigger_next_round(&mut self) {
        self.round_num = (self.round_num % 12) + 1;
        self.round_sec = 60.0;
        self.bell_flash = 1.0;
        self.rope_vib = (self.rope_vib + 2.4).min(6.0);
        for f in &mut self.fighters {
            f.hp = 1.0;
            f.hp_lag = 1.0;
            f.dizzy_timer = 0.0;
            f.combo_hits = 0;
        }
    }

    fn step(&mut self, dt: f32) {
        self.user_active_timer = (self.user_active_timer - dt).max(0.0);
        self.bell_flash = (self.bell_flash - dt * 2.2).max(0.0);
        self.combo_glow = (self.combo_glow - dt * 1.4).max(0.0);
        self.rope_vib = (self.rope_vib - dt * 4.8).max(0.0);

        if self.tire_smash > 0.0 {
            self.tire_smash += dt * 1.85;
            if self.tire_smash >= 1.0 {
                self.tire_smash = 0.0;
            }
        }

        // Đồng hồ hiệp đấu đếm ngược nhẹ nhàng, hết 60s tự sang hiệp mới
        self.round_sec -= dt * 0.65;
        if self.round_sec <= 0.0 {
            self.trigger_next_round();
        }

        // AI giao đấu tự động theo chế độ autoSpar
        if self.p.auto_spar != 1 {
            self.spar_cd -= dt;
            if self.spar_cd <= 0.0 {
                let r_who = self.rng.next();
                let r_zone = self.rng.next();
                let r_wait = self.rng.next();
                let attacker = if r_who < 0.52 { 0 } else { 1 };
                let target = 1 - attacker;
                if self.fighters[attacker].dizzy_timer <= 0.05 {
                    let zone = if r_zone < 0.34 {
                        HitZone::ChinJab
                    } else if r_zone < 0.68 {
                        HitZone::CheekHook
                    } else if r_zone < 0.88 {
                        HitZone::BodyShot
                    } else {
                        HitZone::HeadTop
                    };
                    let p_mul = if self.p.auto_spar == 2 { 0.88 } else { 0.62 };
                    self.launch_fighter_punch(attacker, target, zone, None, p_mul);
                }
                self.spar_cd = if self.p.auto_spar == 2 {
                    0.26 + r_wait * 0.32
                } else {
                    2.6 + r_wait * 2.1
                };
            }
        }

        // Chia 3 bước nhỏ mỗi khung hình cho toàn bộ hệ lò xo giảm chấn
        let sub_dt = dt / 3.0;
        let wind = (self.fighters[0].weave_ph * 0.45).sin() * 0.018;
        for _ in 0..3 {
            for f in &mut self.fighters {
                f.step_springs(sub_dt);
            }
            self.bag_red.step(sub_dt, wind);
            self.bag_dark_l.step(sub_dt, -wind * 0.8);
            self.bag_right.step(sub_dt, wind * 0.9);
            self.ring_shake.step(sub_dt, 0.0);
        }

        // Cập nhật biểu cảm, chớp mắt, choáng váng & hồi máu sau K.O tạm thời
        for i in 0..2 {
            let r_blink = self.rng.next();
            let f = &mut self.fighters[i];
            let was_dizzy = f.dizzy_timer > 0.0;
            f.weave_ph = (f.weave_ph + dt * if was_dizzy { 7.5 } else { 3.6 }) % (PI * 20.0);
            f.punch_ext = (f.punch_ext - dt * 4.6).max(0.0);
            f.wince_timer = (f.wince_timer - dt).max(0.0);
            f.dizzy_timer = (f.dizzy_timer - dt).max(0.0);
            f.hit_flash = (f.hit_flash - dt * 6.5).max(0.0);
            f.combo_window = (f.combo_window - dt).max(0.0);
            if f.combo_window <= 0.0 {
                f.combo_hits = 0;
            }

            // Khi vừa tỉnh dậy sau cơn choáng K.O -> lắc đầu hồi đầy máu đấu tiếp!
            if was_dizzy && f.dizzy_timer <= 0.0 && f.hp < 0.25 {
                f.hp = 1.0;
                f.hp_lag = 1.0;
                f.head_rot.impulse(if i == 0 { 6.0 } else { -6.0 });
            } else if f.dizzy_timer <= 0.0 && f.combo_window <= 0.0 && f.hp < 1.0 {
                // Tự hồi sức rất nhẹ lúc nghỉ giữa nhịp đòn
                f.hp = (f.hp + dt * 0.025).min(1.0);
            }

            if f.lag_hold > 0.0 {
                f.lag_hold -= dt;
            } else if f.hp_lag > f.hp {
                f.hp_lag = (f.hp_lag - dt * 0.55).max(f.hp);
            } else {
                f.hp_lag = f.hp;
            }

            if f.blink_prog >= 0.0 {
                f.blink_prog += dt * 7.5;
                if f.blink_prog >= 1.0 {
                    f.blink_prog = -1.0;
                }
            } else {
                f.blink_cd -= dt;
                if f.blink_cd <= 0.0 {
                    f.blink_prog = 0.0;
                    f.blink_cd = 2.4 + r_blink * 3.4;
                }
            }
        }

        // Cập nhật các găng tay Boxing đang phóng
        let mut impacts: [Option<PunchSlot>; 4] = [None; 4];
        for (idx, g) in self.punches.iter_mut().enumerate() {
            if !g.active {
                continue;
            }
            g.age += dt;
            if !g.impacted && g.age >= 0.090 {
                g.impacted = true;
                impacts[idx] = Some(*g);
            }
            if g.age >= 0.68 {
                g.active = false;
            }
        }
        for imp in impacts.into_iter().flatten() {
            self.apply_impact(imp);
        }

        // Cập nhật cụm khói tròn Puff
        for pf in &mut self.puffs {
            if !pf.active {
                continue;
            }
            pf.age += dt * 1.05;
            if pf.age >= 1.0 {
                pf.active = false;
            }
        }
    }

    fn draw(&mut self, gl: &glow::Context, sh: &mut Shared, now: f64) {
        let t = ((now - self.t0) / 1000.0) as f32;

        let mut f_pos = [0f32; 8];
        let mut f_head = [0f32; 8];
        let mut f_face = [0f32; 8];
        let mut f_torso = [0f32; 8];
        let mut f_expr = [0f32; 8];

        for i in 0..2 {
            let (bx, by, bob_y) = self.fighter_base_foot(i);
            let f = &self.fighters[i];
            let dizzy_sway = if f.dizzy_timer > 0.0 { (t * 10.0 + i as f32).sin() * 7.5 } else { 0.0 };
            let blink = if f.blink_prog >= 0.0 { (f.blink_prog * PI).sin() } else { 0.0 };

            f_pos[i * 4..i * 4 + 4].copy_from_slice(&[bx, by, bob_y, f.lunge_x.x + dizzy_sway]);
            f_head[i * 4..i * 4 + 4].copy_from_slice(&[
                f.head_x.x + dizzy_sway * 0.45,
                f.head_y.x,
                f.head_rot.x * 0.085 + dizzy_sway * 0.02,
                f.head_squash.x.clamp(-0.58, 0.58),
            ]);
            f_face[i * 4..i * 4 + 4].copy_from_slice(&[f.dent_x, f.dent_y, f.face_push_x.x, f.face_push_y.x]);
            f_torso[i * 4..i * 4 + 4].copy_from_slice(&[
                f.torso_shear.x.clamp(-0.85, 0.85),
                f.torso_squash.x.clamp(-0.45, 0.45),
                f.body_dent.x.clamp(-0.35, 1.25),
                f.punch_ext,
            ]);
            f_expr[i * 4..i * 4 + 4].copy_from_slice(&[
                blink,
                (f.wince_timer * 3.2).clamp(0.0, 1.0),
                (f.dizzy_timer / 1.0).clamp(0.0, 1.0),
                f.hit_flash,
            ]);
        }

        let mut gloves_u = [0f32; 16];
        let mut glove_meta_u = [0f32; 16];
        for (i, g) in self.punches.iter().enumerate() {
            if !g.active {
                continue;
            }
            let (gx, gy, sc_alpha, phase) = if g.age < 0.090 {
                let u = (g.age / 0.090).clamp(0.0, 1.0);
                let ease = 1.0 - (1.0 - u).powi(3);
                (
                    g.orig_x + (g.tx - g.orig_x) * ease,
                    g.orig_y + (g.ty - g.orig_y) * ease,
                    g.peak_scale * (0.45 + 0.55 * ease),
                    u,
                )
            } else if g.age < 0.210 {
                let u = (g.age - 0.090) / 0.120;
                let over = (u * PI).sin() * 11.0;
                (
                    g.tx + g.dir.cos() * over,
                    g.ty + g.dir.sin() * over,
                    g.peak_scale * (1.0 + 0.18 * (u * PI).sin()),
                    1.0,
                )
            } else {
                let u = ((g.age - 0.210) / 0.470).clamp(0.0, 1.0);
                let back = u * u;
                (
                    g.tx + (g.orig_x - g.tx) * back * 0.78,
                    g.ty + (g.orig_y - g.ty) * back * 0.78,
                    g.peak_scale * (1.0 - u),
                    1.1 + u,
                )
            };
            gloves_u[i * 4..i * 4 + 4].copy_from_slice(&[gx, gy, g.dir, sc_alpha]);
            let _ = g.attacker;
            glove_meta_u[i * 4..i * 4 + 4].copy_from_slice(&[g.orig_x, g.orig_y, phase, g.zone.glove_kind()]);
        }

        let mut puffs_u = [0f32; 24];
        for (i, pf) in self.puffs.iter().enumerate() {
            if pf.active {
                puffs_u[i * 4..i * 4 + 4].copy_from_slice(&[pf.x, pf.y, pf.age, pf.seed]);
            }
        }

        let p = &mut sh.prog;
        unsafe { glow::HasContext::use_program(gl, Some(p.prog)) };
        self.b.bind_common(gl, p, sh.noise_tex, sh.seed, t);
        p.f4v(
            gl,
            "uScene",
            &[
                self.p.glove_style as f32,
                self.p.hud_mode as f32,
                self.ring_shake.x,
                self.rope_vib,
            ],
        );
        p.f4v(
            gl,
            "uHud",
            &[
                self.fighters[0].hp,
                self.fighters[0].hp_lag,
                self.fighters[1].hp,
                self.fighters[1].hp_lag,
            ],
        );
        p.f4v(
            gl,
            "uRound",
            &[
                self.round_num as f32,
                self.round_sec,
                self.bell_flash,
                self.combo_glow,
            ],
        );
        p.f4v(
            gl,
            "uGymProps",
            &[
                self.bag_red.x.clamp(-0.65, 0.65),
                self.bag_dark_l.x.clamp(-0.65, 0.65),
                self.bag_right.x.clamp(-0.65, 0.65),
                self.tire_smash,
            ],
        );
        p.f4v(gl, "uFPos", &f_pos);
        p.f4v(gl, "uFHead", &f_head);
        p.f4v(gl, "uFFace", &f_face);
        p.f4v(gl, "uFTorso", &f_torso);
        p.f4v(gl, "uFExpr", &f_expr);
        p.f4v(gl, "uGloves", &gloves_u);
        p.f4v(gl, "uGloveMeta", &glove_meta_u);
        p.f4v(gl, "uPuffs", &puffs_u);
        unsafe { glow::HasContext::draw_arrays(gl, glow::TRIANGLES, 0, 3) };
    }
}

impl Theme for BoxingRing {
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
        let (_w, avail_h, s, cx) = self.scene_metrics();
        self.user_active_timer = 2.2;

        // 1. Click hộp đồng hồ HUD phía trên -> rung chuông sang hiệp mới & hồi đầy máu
        if self.p.hud_mode < 2 {
            let hs = s * if self.p.hud_mode == 1 { 0.78 } else { 1.0 };
            if (x - cx).abs() < 54.0 * hs && (y - 44.0 * hs).abs() < 36.0 * hs {
                self.trigger_next_round();
                self.spawn_puff(cx, 44.0 * hs);
                return;
            }
        }

        // 2. Click Lốp xe tải + Búa tạ ở góc dưới trái -> bổ búa làm lốp nảy Squash & Stretch
        let tire_cx = cx - 420.0 * s;
        let tire_cy = avail_h * 0.845;
        if (x - tire_cx).abs() < 78.0 * s && (y - tire_cy).abs() < 54.0 * s {
            self.tire_smash = 0.01;
            self.ring_shake.impulse(55.0);
            self.spawn_puff(tire_cx, tire_cy - 10.0 * s);
            return;
        }

        // 3. Click 3 bao cát treo ngoài võ đài -> phóng găng đấm bao cát đung đưa con lắc
        let bags: [(u8, f32, f32, f32); 3] = [
            (0, cx - 388.0 * s, avail_h * 0.18 + 82.0 * s, 1.0),
            (1, cx - 448.0 * s, avail_h * 0.29 + 86.0 * s, 1.0),
            (2, cx + 425.0 * s, avail_h * 0.24 + 88.0 * s, -1.0),
        ];
        for &(bag_id, bx, by, from_side) in &bags {
            if (x - bx).abs() < 40.0 * s && (y - by).abs() < 78.0 * s {
                let orig_x = bx - from_side * 96.0 * s;
                let orig_y = by + 18.0 * s;
                let dir = (by - orig_y).atan2(bx - orig_x);
                let slot = self.next_punch_slot % self.punches.len();
                self.next_punch_slot = self.next_punch_slot.wrapping_add(1);
                self.punches[slot] = PunchSlot {
                    active: true,
                    age: 0.0,
                    impacted: false,
                    attacker: None,
                    target: None,
                    zone: HitZone::Bag(bag_id),
                    orig_x,
                    orig_y,
                    tx: bx,
                    ty: by,
                    dir,
                    peak_scale: 0.78,
                    power_mul: 1.0,
                };
                return;
            }
        }

        // 4. Click trên võ đài / võ sĩ: nửa phải -> Võ sĩ Trái đấm Võ sĩ Phải; nửa trái -> Võ sĩ Phải phản đòn
        let (attacker, target) = if x >= cx { (0, 1) } else { (1, 0) };
        let (tgt_bx, tgt_by, _) = self.fighter_base_foot(target);
        let tgt_fx = tgt_bx + self.fighters[target].lunge_x.x * s;
        let head_cy = tgt_by - 115.0 * s;
        let rel_x = (x - tgt_fx) / s;
        let rel_y = (y - head_cy) / s;

        let zone = if rel_y < -14.0 {
            HitZone::HeadTop
        } else if rel_y < 26.0 && rel_x.abs() > 14.0 {
            HitZone::CheekHook
        } else if rel_y < 26.0 {
            HitZone::ChinJab
        } else {
            HitZone::BodyShot
        };

        // Nhường nhịp AI tự động một chút khi người dùng đang trực tiếp bấm đấm
        if self.p.auto_spar == 0 {
            self.spar_cd = self.spar_cd.max(1.8);
        }
        self.launch_fighter_punch(attacker, target, zone, Some((x, y)), 1.0);
    }

    fn is_interacting(&self, _now: f64) -> bool {
        self.user_active_timer > 0.0 || self.tire_smash > 0.0
    }

    fn destroy(&mut self, gl: &glow::Context) {
        self.b.destroy(gl);
    }

    fn field_ms(&self) -> f64 {
        self.b.field_ms
    }
}
