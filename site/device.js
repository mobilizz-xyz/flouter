// Détection de la plateforme, pour adapter les réglages techniques (mémoire, threads).

export const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const IS_MOBILE = IS_IOS || /Android|Mobi/i.test(navigator.userAgent);
