/**
 * Security Utilities - Protection côté client
 * 
 * Inclut:
 * - Sanitization XSS
 * - Validation des entrées
 * - Rate limiting côté client
 */

// ═══════════════════════════════════════════════════════════
// XSS SANITIZATION - Protection contre les injections XSS
// ═══════════════════════════════════════════════════════════

/**
 * Échappe les caractères HTML dangereux
 * @param {string} str - Chaîne à sanitizer
 * @returns {string} Chaîne sécurisée
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  
  const htmlEscapes = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
    '`': '&#x60;',
    '=': '&#x3D;'
  };
  
  return str.replace(/[&<>"'`=\/]/g, char => htmlEscapes[char]);
}

/**
 * Supprime les balises HTML d'une chaîne
 * @param {string} str - Chaîne à nettoyer
 * @returns {string} Chaîne sans balises HTML
 */
export function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '');
}

/**
 * Sanitize une URL pour éviter les injections javascript:
 * @param {string} url - URL à vérifier
 * @returns {string|null} URL sécurisée ou null si dangereuse
 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return null;
  
  const trimmed = url.trim().toLowerCase();
  
  // Bloquer les protocoles dangereux
  const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:'];
  if (dangerousProtocols.some(protocol => trimmed.startsWith(protocol))) {
    return null;
  }
  
  // Autoriser les URLs relatives et les protocoles sûrs
  if (trimmed.startsWith('/') || 
      trimmed.startsWith('http://') || 
      trimmed.startsWith('https://') ||
      trimmed.startsWith('mailto:')) {
    return url;
  }
  
  // Par défaut, traiter comme URL relative
  return url;
}

// ═══════════════════════════════════════════════════════════
// INPUT VALIDATION - Validation des entrées utilisateur
// ═══════════════════════════════════════════════════════════

/**
 * Valide un email
 * @param {string} email - Email à valider
 * @returns {boolean} true si valide
 */
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

/**
 * Valide un mot de passe fort
 * @param {string} password - Mot de passe à valider
 * @returns {Object} { valid: boolean, message?: string, strength: 'weak'|'medium'|'strong' }
 */
export function validatePassword(password) {
  if (typeof password !== 'string') {
    return { valid: false, message: 'Mot de passe requis', strength: 'weak' };
  }
  
  if (password.length < 8) {
    return { valid: false, message: 'Minimum 8 caractères', strength: 'weak' };
  }
  
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumbers = /[0-9]/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>_\-+=\[\]\\\/`~]/.test(password);
  
  if (!hasUppercase) {
    return { valid: false, message: 'Au moins une majuscule requise', strength: 'weak' };
  }
  if (!hasLowercase) {
    return { valid: false, message: 'Au moins une minuscule requise', strength: 'weak' };
  }
  if (!hasNumbers) {
    return { valid: false, message: 'Au moins un chiffre requis', strength: 'medium' };
  }
  if (!hasSpecial) {
    return { valid: false, message: 'Au moins un caractère spécial requis (!@#$%...)', strength: 'medium' };
  }
  
  // Calculer la force
  let strength = 'medium';
  if (password.length >= 12 && hasUppercase && hasLowercase && hasNumbers && hasSpecial) {
    strength = 'strong';
  }
  if (password.length >= 16 && hasUppercase && hasLowercase && hasNumbers && hasSpecial) {
    strength = 'very-strong';
  }

  return { valid: true, strength };
}

/**
 * Valide un nom d'affichage
 * @param {string} name - Nom à valider
 * @returns {Object} { valid: boolean, message?: string }
 */
export function validateDisplayName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    return { valid: false, message: 'Nom requis' };
  }
  
  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return { valid: false, message: 'Minimum 2 caractères' };
  }
  if (trimmed.length > 100) {
    return { valid: false, message: 'Maximum 100 caractères' };
  }
  
  return { valid: true };
}

// ═══════════════════════════════════════════════════════════
// CLIENT-SIDE RATE LIMITING - Protection contre le spam
// ═══════════════════════════════════════════════════════════

const rateLimitStore = new Map();

/**
 * Vérifie si une action est autorisée (rate limiting côté client)
 * @param {string} action - Identifiant de l'action (ex: 'login', 'register')
 * @param {number} maxAttempts - Nombre max de tentatives
 * @param {number} windowMs - Fenêtre de temps en ms
 * @returns {Object} { allowed: boolean, remainingAttempts: number, resetTime?: Date }
 */
export function checkRateLimit(action, maxAttempts = 5, windowMs = 60000) {
  const now = Date.now();
  let data = rateLimitStore.get(action);
  
  // Nettoyer si la fenêtre est expirée
  if (data && now > data.resetTime) {
    data = null;
  }
  
  if (!data) {
    data = { count: 1, resetTime: now + windowMs };
    rateLimitStore.set(action, data);
    return { allowed: true, remainingAttempts: maxAttempts - 1 };
  }
  
  if (data.count >= maxAttempts) {
    return { 
      allowed: false, 
      remainingAttempts: 0, 
      resetTime: new Date(data.resetTime) 
    };
  }
  
  data.count++;
  return { allowed: true, remainingAttempts: maxAttempts - data.count };
}

/**
 * Réinitialise le rate limit pour une action (après succès)
 * @param {string} action - Identifiant de l'action
 */
export function resetRateLimit(action) {
  rateLimitStore.delete(action);
}

// ═══════════════════════════════════════════════════════════
// SECURE STORAGE - Gestion sécurisée du stockage
// ═══════════════════════════════════════════════════════════

/**
 * Stocke une valeur de manière sécurisée dans sessionStorage (préféré) ou localStorage
 * @param {string} key - Clé de stockage
 * @param {any} value - Valeur à stocker
 * @param {boolean} persistent - Si true, utilise localStorage
 */
export function secureStore(key, value, persistent = true) {
  const storage = persistent ? localStorage : sessionStorage;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error('Storage error:', e);
  }
}

/**
 * Récupère une valeur stockée
 * @param {string} key - Clé de stockage
 * @param {boolean} persistent - Si true, cherche dans localStorage
 * @returns {any} Valeur stockée ou null
 */
export function secureRetrieve(key, persistent = true) {
  const storage = persistent ? localStorage : sessionStorage;
  try {
    const value = storage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Supprime une valeur stockée
 * @param {string} key - Clé de stockage
 */
export function secureRemove(key) {
  try {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  } catch (e) {
    console.error('Storage error:', e);
  }
}

// ═══════════════════════════════════════════════════════════
// CONTENT SECURITY - Protection du contenu affiché
// ═══════════════════════════════════════════════════════════

/**
 * Sanitize le contenu d'un message pour l'affichage
 * Préserve les sauts de ligne et les liens, mais échappe le HTML dangereux
 * @param {string} content - Contenu du message
 * @returns {string} Contenu sécurisé
 */
export function sanitizeMessageContent(content) {
  if (typeof content !== 'string') return '';
  
  // Échapper le HTML
  let safe = escapeHtml(content);
  
  // Convertir les URLs en liens cliquables (version texte seulement)
  // Note: Le composant React doit gérer le rendu des liens
  
  return safe;
}

/**
 * Détecte si une chaîne contient du contenu potentiellement malveillant
 * @param {string} str - Chaîne à vérifier
 * @returns {boolean} true si contenu suspect détecté
 */
export function hasSuspiciousContent(str) {
  if (typeof str !== 'string') return false;
  
  const suspiciousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,  // Event handlers like onclick=, onerror=
    /data:text\/html/i,
    /data:application\/javascript/i,
  ];
  
  return suspiciousPatterns.some(pattern => pattern.test(str));
}

// ═══════════════════════════════════════════════════════════
// DEV TOOLS ANTI-SELF-XSS WARNING
// Warns users not to paste code in console (common scam vector)
// ═══════════════════════════════════════════════════════════

const DEVTOOLS_WARNING_ASCII = String.raw`
   _____ _______ ____  _____    _ 
  / ____|__   __/ __ \|  __ \  | |
 | (___    | | | |  | | |__) | | |
  \___ \   | | | |  | |  ___/  | |
  ____) |  | | | |__| | |      |_|
 |_____/   |_|  \____/|_|      (_)
                                  
                                  
`;

/**
 * Logs anti-self-XSS warning to console.
 * Call repeatedly so it appears when dev tools are open.
 */
export function logDevToolsWarning() {
  const msg = [
    '%c HEY STOP! ',
    'background: #ed4245; color: white; font-size: 24px; font-weight: bold; padding: 12px 24px; border-radius: 8px;',
  ];
  const ascii = [
    '%c' + DEVTOOLS_WARNING_ASCII,
    'color: #ed4245; font-weight: bold; font-family: monospace; white-space: pre;',
  ];
  const warn = [
    '%c⚠️  WARNING',
    'color: #faa61a; font-weight: bold; font-size: 14px;',
  ];
  const body = [
    '%cIf someone told you to paste something here, it could be used to STEAL your information and YOUR ACCOUNT.\nNever paste or run code in the console unless you know exactly what it does.',
    'color: #b9bbbe; font-size: 13px; line-height: 1.5;',
  ];
  try {
    for (let i = 0; i < 1; i++) {
      console.log('%c HEY STOP! ', 'background: #ed4245; color: white; font-size: 20px; font-weight: bold;');
    }
    console.log('%c\n', '');
    console.log(...msg);
    console.log(...ascii);
    console.log(...warn);
    console.log(...body);
    console.log('%c\n', '');
  } catch (_) {}
}

/**
 * Starts dev tools warning. Runs 4 times total with a short delay, then stops.
 */
export function startDevToolsWarning() {
  if (typeof window === 'undefined') return;
  for (let i = 0; i < 4; i++) {
    setTimeout(() => logDevToolsWarning(), i * 300);
  }
}
