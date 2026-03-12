import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { getToken } from './utils/tokenStorage';
import AppLayout from './layouts/AppLayout';
import ElectronTitleBar from './components/ElectronTitleBar';

const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const InvitePage = lazy(() => import('./pages/InvitePage'));
const AdminPanel = lazy(() => import('./pages/AdminPanel'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const TermsOfService = lazy(() => import('./pages/TermsOfService'));
const QrLoginRedirect = lazy(() => import('./pages/QrLoginRedirect'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail'));
const LandingPage = lazy(() => import('./pages/LandingPage'));
const NotFound = lazy(() => import('./pages/NotFound'));

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const hasToken = !!getToken();
  if (!loading && !user) return <Navigate to="/login" replace />;
  if (loading && !hasToken) return null;
  return children;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  const hasToken = !!getToken();
  if (!loading && user) return <Navigate to="/channels/@me" replace />;
  if (loading && hasToken) return null;
  return children;
}

export default function App() {
  const isElectron = typeof window !== 'undefined' && !!window.electron?.isElectron;
  const isCapacitor = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
  const isNativeApp = isElectron || isCapacitor;
  const rootRedirect = getToken() ? '/channels/@me' : '/login';

  return (
    <div className={`app-root ${isElectron ? 'has-electron-title-bar' : ''}`}>
      <ElectronTitleBar />
      <div className="app-content">
        <Suspense fallback={null}>
          <Routes>
            <Route
              path="/"
              element={
                isNativeApp
                  ? <Navigate to={rootRedirect} replace />
                  : <PublicRoute><LandingPage /></PublicRoute>
              }
            />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<TermsOfService />} />
            <Route path="/invite/:code" element={<InvitePage />} />
            <Route path="/qr-login" element={<QrLoginRedirect />} />
            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <AdminPanel />
                </ProtectedRoute>
              }
            />
            <Route path="/channels" element={<NotFound />} />
            <Route
              path="/*"
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </div>
    </div>
  );
}
