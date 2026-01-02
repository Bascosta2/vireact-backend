# Google OAuth 2.0 Setup Guide

This guide will help you set up Google OAuth 2.0 authentication for your application.

## Prerequisites

1. A Google Cloud Console account
2. A Google Cloud Project

## Step 1: Create Google OAuth Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project or create a new one
3. Navigate to "APIs & Services" > "Credentials"
4. Click "Create Credentials" > "OAuth 2.0 Client IDs"
5. Choose "Web application" as the application type
6. Add the following authorized redirect URIs:
   - `http://localhost:5000/api/v1/auth/google/callback` (for development)
   - `https://yourdomain.com/api/v1/auth/google/callback` (for production)
7. Save and copy your Client ID and Client Secret

## Step 2: Environment Variables

Add the following environment variables to your `.env` file:

```env
# Google OAuth Configuration
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_CALLBACK_URL=http://localhost:5000/api/v1/auth/google/callback

# Session Secret (can be same as JWT_SECRET)
SESSION_SECRET=your_session_secret_here
```

## Step 3: API Endpoints

The following Google OAuth endpoints are now available:

### Authentication Flow
- `GET /api/v1/auth/google` - Initiate Google OAuth login
- `GET /api/v1/auth/google/callback` - Google OAuth callback
- `GET /api/v1/auth/google/failure` - OAuth failure handler

### Usage Examples

#### Frontend Integration

```javascript
// Redirect to Google OAuth
window.location.href = 'http://localhost:5000/api/v1/auth/google';

// With custom redirect URL
window.location.href = 'http://localhost:5000/api/v1/auth/google?redirect=' + encodeURIComponent('/dashboard');
```

#### Handle OAuth Success

The callback will redirect to your frontend with user data:

```
http://localhost:5173/dashboard?auth=success&data=<encoded_user_data>
```

Parse the user data in your frontend:

```javascript
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('auth') === 'success') {
    const userData = JSON.parse(decodeURIComponent(urlParams.get('data')));
    console.log('User:', userData.user);
    console.log('Access Token:', userData.accessToken);
}
```

## Step 4: User Model Features

The User model now supports:

- **OAuth Users**: Users who sign up/login with Google
- **Local Users**: Users who sign up with email/password
- **Account Linking**: Existing email users can link their Google account
- **Email Verification**: Automatically verified for Google users

## Step 5: Testing

1. Start your server: `npm run dev`
2. Navigate to: `http://localhost:5000/api/v1/auth/google`
3. Complete the Google OAuth flow
4. Check that you're redirected back to your frontend with user data

## Security Notes

- Always use HTTPS in production
- Keep your Google Client Secret secure
- Use environment variables for all sensitive data
- The session cookie is httpOnly and secure in production

## Troubleshooting

### Common Issues

1. **"redirect_uri_mismatch"**: Ensure your callback URL matches exactly in Google Console
2. **"invalid_client"**: Check your Client ID and Secret
3. **Session issues**: Ensure SESSION_SECRET is set in environment variables

### Debug Mode

Enable debug logging by setting:
```env
NODE_ENV=development
```

This will provide more detailed error messages during development.
