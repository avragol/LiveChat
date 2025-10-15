import React from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';

interface GoogleUser {
    name: string;
    email: string;
    picture: string;
}

interface GoogleAuthProps {
    onSuccess: (user: GoogleUser) => void;
    onError: () => void;
}

const GoogleAuth: React.FC<GoogleAuthProps> = ({ onSuccess, onError }) => {
    const handleSuccess = (credentialResponse: any) => {
        try {
            if (credentialResponse.credential) {
                const decoded: any = jwtDecode(credentialResponse.credential);
                const user: GoogleUser = {
                    name: decoded.name,
                    email: decoded.email,
                    picture: decoded.picture
                };
                onSuccess(user);
            }
        } catch (error) {
            console.error('Error decoding Google token:', error);
            onError();
        }
    };

    const handleError = () => {
        console.error('Google Login Failed');
        onError();
    };

    return (
        <div className="google-auth-container">
            <div className="google-auth-info">
                <h3 className="google-auth-title">Sign in with Google</h3>
                <p className="google-auth-subtitle">
                    Use your Google account to join the chat
                </p>
            </div>

            <GoogleLogin
                onSuccess={handleSuccess}
                onError={handleError}
                useOneTap={false}
                shape="rectangular"
                theme="outline"
                size="large"
            />

            <div className="google-auth-privacy">
                <p>We only use your name for the chat. No data is stored on our servers.</p>
            </div>
        </div>
    );
};

export default GoogleAuth;
