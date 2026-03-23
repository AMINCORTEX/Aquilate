import mongoose from 'mongoose';

// ── Milestone Sub-schema ──────────────────────────────────────────────────────
const milestoneSchema = new mongoose.Schema({
    id:              { type: String, required: true },
    title:           { type: String, required: true },
    type:            { type: String, enum: ['stop', 'start', 'become', 'fix'], required: true },
    pillar:          { type: String, required: true },
    status:          { type: String, enum: ['active', 'struggling', 'broken', 'completed'], default: 'active' },
    startDate:       { type: String, required: true },
    completedDate:   { type: String, default: null },
    statusChangedAt: { type: String, default: null },
    tasks:           { type: [String], default: [] },
}, { _id: false });

// ── User Schema ───────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true,      // always required — bcrypt hash stored here
    },
    provider: {
        type: String,
        enum: ['local'],
        default: 'local'
    },
    pillars: {
        type: [String],
        default: [],
        validate: {
            validator: function(arr) { return arr.length <= 5; },
            message: 'Maximum 5 pillars allowed'
        }
    },
    pillarColors:   { type: Map, of: String,   default: {} },
    pillarProgress: { type: Map, of: Number,   default: {} },
    habits:         { type: Map, of: [String], default: {} },
    milestones:     { type: [milestoneSchema], default: [] },
    createdAt:      { type: Date, default: Date.now },
    lastLogin:      { type: Date, default: Date.now }
});

userSchema.methods.toSafeJSON = function() {
    const user = this.toObject();
    delete user.password;     // never expose the hash to clients
    if (user.pillarColors   instanceof Map) user.pillarColors   = Object.fromEntries(user.pillarColors);
    if (user.pillarProgress instanceof Map) user.pillarProgress = Object.fromEntries(user.pillarProgress);
    if (user.habits         instanceof Map) user.habits         = Object.fromEntries(user.habits);
    return user;
};

userSchema.methods.toJSON = userSchema.methods.toSafeJSON;

export default mongoose.model('User', userSchema);