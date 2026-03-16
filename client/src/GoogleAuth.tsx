import React from 'react';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';

interface GoogleAuthProps {
  onSuccess: (idToken: string) => void;
  onError: () => void;
}

const GoogleAuth: React.FC<GoogleAuthProps> = ({ onSuccess, onError }) => {
  const handleSuccess = (credentialResponse: CredentialResponse) => {
    if (credentialResponse.credential) {
      // Pass the raw ID token to the parent — server will verify it
      onSuccess(credentialResponse.credential);
    } else {
      onError();
    }
  };

  return (
    <div className="google-auth-container">
      <div className="google-auth-info">
        <h3 className="google-auth-title">Sign in with Google</h3>
        <p className="google-auth-subtitle">Use your Google account to join the chat</p>
      </div>
      <GoogleLogin
        onSuccess={handleSuccess}
        onError={onError}
        useOneTap={false}
        shape="rectangular"
        theme="outline"
        size="large"
      />
      <div className="google-auth-privacy">
        <p>We only use your name for the chat.</p>
      </div>
    </div>
  );
};

export default GoogleAuth;
