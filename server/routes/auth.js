// server/routes/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// Custom email / password authentication + all user data routes.
// Required .env variables:
//   JWT_SECRET     — long random string for signing JWTs
//   JWT_EXPIRES_IN — optional, defaults to '30d'
//   GMAIL_USER         — sender address for OTP emails
//   GMAIL_APP_PASSWORD — 16-char App Password from Google
// ─────────────────────────────────────────────────────────────────────────────

import express  from 'express';
import jwt      from 'jsonwebtoken';
import bcrypt   from 'bcryptjs';
import User     from '../models/User.js';
import { sendOTPEmail } from '../mailer.js';

const router = express.Router();

// ── In-memory OTP store ───────────────────────────────────────────────────────
// Keyed by email → { code, expiresAt, userData }
// userData is only set during signup (holds name + hashed password until verified)
const otpStore = new Map();

// ── JWT helpers ───────────────────────────────────────────────────────────────
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set in .env');
    return secret;
}

function signToken(userId) {
    const secret  = getJwtSecret();
    const expires = process.env.JWT_EXPIRES_IN || '30d';
    return jwt.sign({ id: userId }, secret, { expiresIn: expires });
}

// ── Auth middleware ───────────────────────────────────────────────────────────
export function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: no token provided' });
    }
    const token = header.slice(7);
    try {
        const decoded = jwt.verify(token, getJwtSecret());
        req.userId = decoded.id;
        next();
    } catch {
        return res.status(401).json({ error: 'Unauthorized: invalid or expired token' });
    }
}

// ── Ownership guard ───────────────────────────────────────────────────────────
function requireOwnership(req, res, next) {
    if (req.userId !== req.params.id) {
        return res.status(403).json({ error: 'Forbidden: access denied' });
    }
    next();
}

// ── OTP helpers ───────────────────────────────────────────────────────────────
function generateOTP() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function storeOTP(email, code, userData = null) {
    otpStore.set(email.toLowerCase(), {
        code,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
        userData,
    });
}

function getOTP(email) {
    return otpStore.get(email.toLowerCase()) || null;
}

function clearOTP(email) {
    otpStore.delete(email.toLowerCase());
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES — SIGNUP
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
// Step 1: Validate inputs, hash password, send OTP. Does NOT create user yet.
// Body: { name, email, password }
router.post('/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email and password are required.' });
        }

        const trimmedName  = name.trim();
        const trimmedEmail = email.trim().toLowerCase();

        if (trimmedName.length < 2) {
            return res.status(400).json({ error: 'Name must be at least 2 characters.' });
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
            return res.status(400).json({ error: 'Invalid email address.' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        // Check if email already registered
        const existing = await User.findOne({ email: trimmedEmail });
        if (existing) {
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }

        // Hash password before storing in OTP cache
        const hashedPassword = await bcrypt.hash(password, 12);
        const code = generateOTP();

        storeOTP(trimmedEmail, code, {
            name:     trimmedName,
            email:    trimmedEmail,
            password: hashedPassword,
        });

        await sendOTPEmail(trimmedEmail, code);
        console.log(`[auth/signup] OTP sent to ${trimmedEmail}`);

        return res.json({ message: 'Verification code sent. Check your email.' });

    } catch (err) {
        console.error('[auth/signup] Error:', err);
        res.status(500).json({ error: 'Signup failed. Please try again.' });
    }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
// Step 2 (signup): Verify OTP, create account, return JWT.
// Body: { email, code }
router.post('/verify-otp', async (req, res) => {
    try {
        const { email, code } = req.body;

        if (!email || !code) {
            return res.status(400).json({ error: 'Email and code are required.' });
        }

        const trimmedEmail = email.trim().toLowerCase();
        const entry = getOTP(trimmedEmail);

        if (!entry) {
            return res.status(400).json({ error: 'No pending verification for this email. Please sign up again.' });
        }

        if (Date.now() > entry.expiresAt) {
            clearOTP(trimmedEmail);
            return res.status(400).json({ error: 'Verification code expired. Please sign up again.' });
        }

        if (entry.code !== String(code).trim()) {
            return res.status(400).json({ error: 'Incorrect verification code.' });
        }

        if (!entry.userData) {
            // Should never happen, but guard anyway
            clearOTP(trimmedEmail);
            return res.status(400).json({ error: 'Session expired. Please sign up again.' });
        }

        // Double-check the email wasn't registered by someone else while we waited
        const existing = await User.findOne({ email: trimmedEmail });
        if (existing) {
            clearOTP(trimmedEmail);
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }

        // Create the user
        const { name, password } = entry.userData;
        const user = new User({
            name,
            email:          trimmedEmail,
            password,
            provider:       'local',
            pillars:        [],
            pillarColors:   {},
            pillarProgress: {},
            habits:         {},
            milestones:     [],
        });

        await user.save();
        clearOTP(trimmedEmail);

        const token = signToken(user._id.toString());
        console.log(`[auth/verify-otp] Account created for ${trimmedEmail}`);

        return res.json({ token, user: user.toSafeJSON() });

    } catch (err) {
        console.error('[auth/verify-otp] Error:', err);
        res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
});

// ── POST /api/auth/resend-otp ─────────────────────────────────────────────────
// Resends a fresh OTP for an existing pending signup session.
// Body: { email }
router.post('/resend-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required.' });

        const trimmedEmail = email.trim().toLowerCase();
        const entry = getOTP(trimmedEmail);

        if (!entry || !entry.userData) {
            return res.status(400).json({ error: 'No pending verification found. Please sign up again.' });
        }

        const code = generateOTP();
        storeOTP(trimmedEmail, code, entry.userData); // refresh with new code + new expiry
        await sendOTPEmail(trimmedEmail, code);

        return res.json({ message: 'New verification code sent.' });

    } catch (err) {
        console.error('[auth/resend-otp] Error:', err);
        res.status(500).json({ error: 'Failed to resend code. Please try again.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES — LOGIN
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Body: { email, password }
// Returns: { token, user }
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const trimmedEmail = email.trim().toLowerCase();

        const user = await User.findOne({ email: trimmedEmail });

        // Use a generic message to avoid leaking whether the email exists
        if (!user || !user.password) {
            return res.status(401).json({ error: 'Incorrect email or password.' });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ error: 'Incorrect email or password.' });
        }

        user.lastLogin = new Date();
        await user.save();

        const token = signToken(user._id.toString());
        console.log(`[auth/login] ${trimmedEmail} logged in`);

        return res.json({ token, user: user.toSafeJSON() });

    } catch (err) {
        console.error('[auth/login] Error:', err);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// USER DATA ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /api/auth/user/:id ────────────────────────────────────────────────────
router.get('/user/:id', requireAuth, requireOwnership, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user.toSafeJSON());
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Failed to get user' });
    }
});

// ── PUT /api/auth/user/:id ────────────────────────────────────────────────────
router.put('/user/:id', requireAuth, requireOwnership, async (req, res) => {
    try {
        const { name, pillars, pillarColors, pillarProgress } = req.body;
        const updates = {};

        if (name !== undefined) updates.name = name.trim();
        if (pillars !== undefined) updates.pillars = pillars;

        if (pillarColors !== undefined && typeof pillarColors === 'object') {
            for (const [pillar, color] of Object.entries(pillarColors)) {
                updates[`pillarColors.${pillar}`] = color;
            }
        }

        if (pillarProgress !== undefined && typeof pillarProgress === 'object') {
            for (const [pillar, value] of Object.entries(pillarProgress)) {
                const num = Number(value);
                if (!isNaN(num)) updates[`pillarProgress.${pillar}`] = Math.min(100, Math.max(0, num));
            }
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({ error: 'No valid fields provided' });
        }

        const user = await User.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true, runValidators: false }
        );

        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'User updated successfully', user: user.toSafeJSON() });

    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// ── PATCH /api/auth/user/:id/pillar-progress ─────────────────────────────────
router.patch('/user/:id/pillar-progress', requireAuth, requireOwnership, async (req, res) => {
    try {
        const { pillarProgress } = req.body;

        if (!pillarProgress || typeof pillarProgress !== 'object') {
            return res.status(400).json({ error: 'pillarProgress must be a non-null object' });
        }

        const setPayload = {};
        for (const [pillar, value] of Object.entries(pillarProgress)) {
            const num = Number(value);
            if (!isNaN(num)) setPayload[`pillarProgress.${pillar}`] = Math.min(100, Math.max(0, num));
        }

        if (!Object.keys(setPayload).length) {
            return res.status(400).json({ error: 'No valid pillar values provided' });
        }

        const user = await User.findByIdAndUpdate(
            req.params.id,
            { $set: setPayload },
            { new: true, runValidators: false }
        );

        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'Progress saved', user: user.toSafeJSON() });

    } catch (error) {
        console.error('[pillar-progress PATCH] error:', error);
        res.status(500).json({ error: 'Failed to save progress' });
    }
});

// ── PATCH /api/auth/user/:id/habits ──────────────────────────────────────────
router.patch('/user/:id/habits', requireAuth, requireOwnership, async (req, res) => {
    try {
        const { habits } = req.body;

        if (!habits || typeof habits !== 'object') {
            return res.status(400).json({ error: 'habits must be a non-null object' });
        }

        const setPayload = {};
        for (const [pillar, habitList] of Object.entries(habits)) {
            if (!Array.isArray(habitList)) continue;
            const clean = habitList.map(h => String(h).trim()).filter(h => h.length > 0).slice(0, 20);
            setPayload[`habits.${pillar}`] = clean;
        }

        if (!Object.keys(setPayload).length) {
            return res.status(400).json({ error: 'No valid habit data provided' });
        }

        const user = await User.findByIdAndUpdate(
            req.params.id,
            { $set: setPayload },
            { new: true, runValidators: false }
        );

        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'Habits saved', user: user.toSafeJSON() });

    } catch (error) {
        console.error('[habits PATCH] error:', error);
        res.status(500).json({ error: 'Failed to save habits' });
    }
});

// ── MILESTONES ────────────────────────────────────────────────────────────────
router.get('/user/:id/milestones', requireAuth, requireOwnership, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ milestones: user.milestones || [] });
    } catch {
        res.status(500).json({ error: 'Failed to get milestones' });
    }
});

router.post('/user/:id/milestones', requireAuth, requireOwnership, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const { id, title, type, pillar, startDate, tasks } = req.body;
        if (!id || !title || !type || !pillar || !startDate) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const activeCount = user.milestones.filter(m => m.status === 'active').length;
        if (activeCount >= 3) {
            return res.status(400).json({ error: 'MAX_ACTIVE', message: 'Maximum 3 active milestones reached' });
        }

        const today = new Date().toISOString().slice(0, 10);
        const cleanTasks = Array.isArray(tasks)
            ? tasks.map(t => String(t).trim()).filter(t => t.length > 0).slice(0, 5)
            : [];

        user.milestones.push({
            id, title, type, pillar, startDate,
            status:          'active',
            completedDate:   null,
            statusChangedAt: today,
            tasks:           cleanTasks,
        });

        await user.save();
        res.json({ message: 'Milestone created', milestones: user.milestones });
    } catch (e) {
        console.error('[milestones POST]', e);
        res.status(500).json({ error: 'Failed to create milestone' });
    }
});

router.patch('/user/:id/milestones/:milestoneId', requireAuth, requireOwnership, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const m = user.milestones.find(m => m.id === req.params.milestoneId);
        if (!m) return res.status(404).json({ error: 'Milestone not found' });

        const { status, completedDate, statusChangedAt, tasks } = req.body;

        if (status !== undefined) {
            const allowed = ['active', 'struggling', 'broken', 'completed'];
            if (!allowed.includes(status)) {
                return res.status(400).json({ error: 'Invalid status' });
            }
            m.status          = status;
            m.statusChangedAt = statusChangedAt || new Date().toISOString().slice(0, 10);
            if (status === 'completed' && completedDate) m.completedDate = completedDate;
        }

        if (Array.isArray(tasks)) {
            m.tasks = tasks.map(t => String(t).trim()).filter(t => t.length > 0).slice(0, 5);
        }

        await user.save();
        res.json({ message: 'Milestone updated', milestones: user.milestones });
    } catch (e) {
        console.error('[milestones PATCH]', e);
        res.status(500).json({ error: 'Failed to update milestone' });
    }
});

router.delete('/user/:id/milestones/:milestoneId', requireAuth, requireOwnership, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const exists = user.milestones.some(m => m.id === req.params.milestoneId);
        if (!exists) return res.status(404).json({ error: 'Milestone not found' });

        user.milestones = user.milestones.filter(m => m.id !== req.params.milestoneId);
        await user.save();
        res.json({ message: 'Milestone deleted', milestones: user.milestones });
    } catch (e) {
        console.error('[milestones DELETE]', e);
        res.status(500).json({ error: 'Failed to delete milestone' });
    }
});

export default router;