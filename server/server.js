import 'dotenv/config';
import express       from 'express';
import mongoose      from 'mongoose';
import cors          from 'cors';
import authRoutes    from './routes/auth.js';
import contactRoutes from './routes/contact.js';

const app  = express();
const PORT = process.env.PORT || 5000;

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Database ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅  MongoDB Atlas connected'))
    .catch(err => {
        console.error('❌  MongoDB connection error:', err);
        process.exit(1);
    });

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/contact', contactRoutes);

app.get('/', (req, res) => {
    res.json({
        message:  'Audenta API is running',
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        endpoints: [
            'POST /api/auth/signup',
            'POST /api/auth/verify-otp',
            'POST /api/auth/resend-otp',
            'POST /api/auth/login',
            'GET  /api/auth/user/:id                          [auth]',
            'PUT  /api/auth/user/:id                          [auth]',
            'PATCH /api/auth/user/:id/pillar-progress         [auth]',
            'PATCH /api/auth/user/:id/habits                  [auth]',
            'GET  /api/auth/user/:id/milestones               [auth]',
            'POST /api/auth/user/:id/milestones               [auth]',
            'PATCH /api/auth/user/:id/milestones/:milestoneId [auth]',
            'DELETE /api/auth/user/:id/milestones/:milestoneId [auth]',
            'POST /api/contact/send',
        ]
    });
});

app.get('/health', (req, res) => {
    res.json({
        status:    'ok',
        database:  mongoose.connection.readyState === 1 ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString()
    });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`🚀  Server running on http://localhost:${PORT}`);
});