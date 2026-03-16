import React from 'react';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';

interface GoogleAuthProps {
  onSuccess: (idToken: string) => void;
  onError: () => void;
}

const GoogleAuth: React.FC<GoogleAuthProps> = ({ onSuccess, onError }) => {
  const handleSuccess = (credentialResponse: CredentialResponse) => {
    if (credentialResponse.credential) {
      onSuccess(credentialResponse.credential);
    } else {
      onError();
    }
  };

  return (
    <div className="google-auth-container">
      <div className="google-auth-info">
        <h3 className="google-auth-title">כניסה עם Google</h3>
        <p className="google-auth-subtitle">השתמש בחשבון Google שלך להצטרפות לצ'אט</p>
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
        <p>אנחנו משתמשים רק בשמך עבור הצ'אט.</p>
      </div>
    </div>
  );
};

export default GoogleAuth;
