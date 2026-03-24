import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { teams as teamsApi } from '../api';
import { getStaticUrl } from '../utils/staticUrl';
import './ElectronTitleBar.css';

export default function ElectronTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [teamData, setTeamData] = useState(null);
  const hasElectron = typeof window !== 'undefined' && !!window.electron;
  const location = useLocation();
  const navigate = useNavigate();

  // Extract teamId from current path
  const teamId = useMemo(() => {
    const m = location.pathname.match(/\/team\/(\d+)/);
    return m ? m[1] : null;
  }, [location.pathname]);

  // Fetch team data when teamId changes
  useEffect(() => {
    if (!teamId) { setTeamData(null); return; }
    let cancelled = false;
    teamsApi.get(teamId).then((t) => { if (!cancelled) setTeamData(t); }).catch(() => {});
    return () => { cancelled = true; };
  }, [teamId]);

  useEffect(() => {
    if (!window.electron?.isMaximized) return;
    const update = (v) => {
      if (v !== undefined) {
        setIsMaximized(v);
      } else {
        window.electron.isMaximized().then(val => setIsMaximized(val));
      }
    };
    update(undefined);
    if (window.electron.onMaximizeChange) {
      return window.electron.onMaximizeChange((v) => setIsMaximized(v));
    }
    const iv = setInterval(() => window.electron.isMaximized().then(setIsMaximized), 2000);
    return () => clearInterval(iv);
  }, []);

  const handleMaximize = () => {
    window.electron.maximize();
    setIsMaximized((v) => !v);
  };

  if (!hasElectron) return null;

  const isMac = window.electron?.platform === 'darwin';

  // Derive page title from current route
  const getPageTitle = () => {
    const path = location.pathname;
    if (path.includes('/channels/@me')) return 'Messages Privés';
    if (path.includes('/settings')) return 'Paramètres';
    if (path.includes('/friends')) return 'Amis';
    if (path.includes('/shop')) return 'Boutique';
    if (path.includes('/admin')) return 'Administration';
    if (teamId && teamData) return teamData.name;
    if (teamId) return 'Serveur';
    return 'Slide';
  };

  // Get the icon to show next to the title
  const getIconElement = () => {
    if (teamId && teamData) {
      const iconSrc = teamData.icon_url || teamData.avatar_url;
      if (iconSrc) {
        return <img src={getStaticUrl(iconSrc)} alt="" className="electron-title-bar-icon" />;
      }
      // Server initials fallback
      const initials = (teamData.name || '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
      return <span className="electron-title-bar-icon-initials">{initials}</span>;
    }
    // Default: Slide logo
    return <img src="/logo.png" alt="" className="electron-title-bar-icon" />;
  };

  const buttons = (
    <>
      {isMac && (
        <button className="electron-title-bar-btn electron-title-bar-close" onClick={() => window.electron.close()} aria-label="Fermer">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M1 1l8 8M9 1L1 9" />
          </svg>
        </button>
      )}
      <button className="electron-title-bar-btn" onClick={() => window.electron.minimize()} aria-label="Réduire">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <rect x="0" y="5" width="12" height="1" />
        </svg>
      </button>
      <button className="electron-title-bar-btn" onClick={handleMaximize} aria-label={isMaximized ? 'Restaurer' : 'Agrandir'}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="0.5" y="0.5" width="11" height="11" rx="0.5" />
        </svg>
      </button>
      {!isMac && (
        <button className="electron-title-bar-btn electron-title-bar-close" onClick={() => window.electron.close()} aria-label="Fermer">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M1 1l8 8M9 1L1 9" />
          </svg>
        </button>
      )}
    </>
  );

  const titleBar = (
    <div className={`electron-title-bar ${isMac ? 'electron-title-bar-mac' : ''}`}>
      {isMac && <div className="electron-title-bar-controls electron-title-bar-controls-left">{buttons}</div>}

      {/* Navigation arrows */}
      <div className="electron-title-bar-nav">
        <button
          className="electron-title-bar-nav-btn"
          onClick={() => navigate(-1)}
          aria-label="Retour"
          title="Retour"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          className="electron-title-bar-nav-btn"
          onClick={() => navigate(1)}
          aria-label="Suivant"
          title="Suivant"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Double-click drag area to maximize/restore */}
      <div className="electron-title-bar-drag" onDoubleClick={handleMaximize} />

      {/* Icon + Title (absolutely centered) */}
      <div className="electron-title-bar-info">
        {getIconElement()}
        <span className="electron-title-bar-title">{getPageTitle()}</span>
      </div>

      {!isMac && <div className="electron-title-bar-controls">{buttons}</div>}
    </div>
  );

  // Render via portal to escape #root stacking context (z-index: 0)
  // so the title bar always stays above modals portaled to document.body
  return createPortal(titleBar, document.body);
}
