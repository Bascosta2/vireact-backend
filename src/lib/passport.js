import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { User } from '../model/user.model.js';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } from '../config/index.js';
import { OAUTH_PROVIDERS } from '../constants.js';

// Configure Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
    try {
        const { id: googleId, emails, displayName, photos } = profile;
        const email = emails && emails[0] ? emails[0].value : null;

        if (!email) {
            return done(new Error('Email is required for Google OAuth'), null);
        }

        // Use the centralized method that handles provider conflicts
        const user = await User.findOrCreateByGoogleProfile(profile);
        return done(null, user);

    } catch (error) {
        return done(error, null);
    }
}));

// Serialize user for session
passport.serializeUser((user, done) => {
    done(null, user._id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id).select('-password');
        done(null, user);
    } catch (error) {
        done(error, null);
    }
});

export default passport;
