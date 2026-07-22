/**
 * Google Workspace Service Module
 * Handles OAuth 2.0 token acquisition via Google Identity Services (GIS)
 * and seamless integration with Firebase Auth.
 */

window.GoogleWorkspaceService = (function () {
    // Default OAuth Client ID
    const GOOGLE_CLIENT_ID = '482319725381-cmr7jil7phjde4hd2qn9epo4sgf3ndtn.apps.googleusercontent.com';

    // Scopes for Google Workspace APIs
    const WORKSPACE_SCOPES = [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify'
    ];

    let tokenClient = null;
    let currentAccessToken = localStorage.getItem('vex_google_access_token') || null;
    let tokenExpiry = localStorage.getItem('vex_google_token_expiry') || 0;

    /**
     * Load Google Identity Services script dynamically if needed
     */
    function loadGisScript() {
        return new Promise((resolve, reject) => {
            if (window.google && window.google.accounts && window.google.accounts.oauth2) {
                resolve();
                return;
            }
            const script = document.createElement('script');
            script.src = 'https://accounts.google.com/gsi/client';
            script.async = true;
            script.defer = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load Google Identity Services SDK'));
            document.head.appendChild(script);
        });
    }

    /**
     * Initialize Token Client
     */
    async function initGIS(customClientId) {
        await loadGisScript();
        const clientId = customClientId || GOOGLE_CLIENT_ID;

        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
            tokenClient = window.google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: WORKSPACE_SCOPES.join(' '),
                callback: (tokenResponse) => {
                    if (tokenResponse && tokenResponse.access_token) {
                        setAccessToken(tokenResponse.access_token, tokenResponse.expires_in);
                        if (window.showToast) {
                            window.showToast('Google Workspace token updated via Google Identity Services!', 'success');
                        }
                        // Dispatch custom event for UI components to reload data
                        window.dispatchEvent(new CustomEvent('google_workspace_token_ready', { detail: { token: tokenResponse.access_token } }));
                    } else if (tokenResponse && tokenResponse.error) {
                        console.error('GIS Token error:', tokenResponse.error);
                        if (window.showToast) {
                            window.showToast('OAuth Error: ' + tokenResponse.error, 'error');
                        }
                    }
                },
            });
        }
    }

    /**
     * Store Access Token in memory, localStorage, and window global
     */
    function setAccessToken(token, expiresInSeconds = 3600) {
        if (!token) return;
        currentAccessToken = token;
        const expiryTime = Date.now() + (expiresInSeconds * 1000);
        tokenExpiry = expiryTime;

        localStorage.setItem('vex_google_access_token', token);
        localStorage.setItem('vex_google_token_expiry', expiryTime.toString());

        // Update global window variables for legacy/direct script compatibility
        window.googleOAuthAccessToken = token;
        if (typeof googleCalendarAccessToken !== 'undefined') googleCalendarAccessToken = token;
        if (typeof keepOAuthAccessToken !== 'undefined') keepOAuthAccessToken = token;
        if (typeof globalGoogleOAuthToken !== 'undefined') globalGoogleOAuthToken = token;
    }

    /**
     * Retrieve a valid Access Token
     */
    function getAccessToken() {
        if (currentAccessToken && Date.now() < parseInt(tokenExpiry || '0')) {
            return currentAccessToken;
        }
        // Fallback to window globals
        return window.googleOAuthAccessToken || currentAccessToken || null;
    }

    /**
     * Request Token via Google Identity Services (GIS)
     */
    async function requestToken(scopes = WORKSPACE_SCOPES) {
        try {
            await loadGisScript();
            if (!tokenClient) {
                await initGIS();
            }
            if (tokenClient) {
                tokenClient.requestAccessToken({ scope: scopes.join(' ') });
            } else {
                throw new Error('Token client failed to initialize');
            }
        } catch (err) {
            console.error('Request token error:', err);
            if (window.showToast) {
                window.showToast('Failed to initialize Google Token Client', 'error');
            }
        }
    }

    /**
     * Handle Firebase Auth Secondary Token Sync
     * Called whenever Firebase Auth logs in or returns a credential
     */
    function handleFirebaseUserCredential(userCredential) {
        if (userCredential && userCredential.credential && userCredential.credential.accessToken) {
            const token = userCredential.credential.accessToken;
            setAccessToken(token, 3600);
        }
    }

    // Auto-sync existing localStorage token on load
    if (currentAccessToken) {
        window.googleOAuthAccessToken = currentAccessToken;
    }

    return {
        initGIS,
        setAccessToken,
        getAccessToken,
        requestToken,
        handleFirebaseUserCredential,
        getScopes: () => WORKSPACE_SCOPES
    };
})();
