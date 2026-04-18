import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { exchangeCodeForToken, saveShopifyStore } from '../lib/shopify-oauth';
import { supabase, ensureValidSession } from '../lib/supabase';
import { useStoreManagement } from '../stores/storeManagement';
import { useOrganization } from '../stores/organizationStore';
import { useAuth } from '../stores/authStore.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Loader2 } from 'lucide-react';

// Module-level guard: survives component remounts (unlike useRef which resets).
// Maps code → true to prevent the same authorization code from being exchanged
// more than once per page load.
const _processedCodes = new Set();

/**
 * Wait for Zustand persist stores to hydrate (org + auth).
 * Polls getState() every 50ms up to maxWaitMs.
 */
async function waitForStoreHydration(maxWaitMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const orgId = useOrganization.getState().activeOrganizationId;
    const user = useAuth.getState().user;
    if (orgId && user) return { orgId, user };
    await new Promise((r) => setTimeout(r, 50));
  }
  // Return whatever we have after timeout
  return {
    orgId: useOrganization.getState().activeOrganizationId,
    user: useAuth.getState().user,
  };
}

export default function ShopifyCallback() {
  const OAUTH_CODE_PREFIX = 'shopify_oauth_code_processed:';
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState('processing');
  const [error, setError] = useState(null);
  const addStore = useStoreManagement((state) => state.addStore);
  // Guard against React 18 Strict Mode double-invocation (code is single-use)
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    const handleCallback = async () => {
      try {
        // Get the authorization code and shop from URL parameters
        const code = searchParams.get('code');
        const shop = searchParams.get('shop');

        if (!code || !shop) {
          throw new Error('Missing authorization code or shop');
        }

        // ---- Module-level guard (survives remounts) ----
        if (_processedCodes.has(code)) {
          console.log('[ShopifyCallback] code already being processed (module guard)');
          setStatus('success');
          setTimeout(() => navigate('/'), 250);
          return;
        }
        _processedCodes.add(code);

        // Prevent duplicate token exchange for the same single-use code.
        const codeKey = `${OAUTH_CODE_PREFIX}${code}`;
        if (sessionStorage.getItem(codeKey) === '1') {
          setStatus('success');
          setTimeout(() => {
            navigate('/');
          }, 250);
          return;
        }
        sessionStorage.setItem(codeKey, '1');

        // Remove OAuth params from URL immediately to reduce accidental reprocessing on refresh/back.
        window.history.replaceState({}, document.title, window.location.pathname);

        // Wait for Zustand persist stores (auth + org) to hydrate after the
        // full page reload caused by the OAuth redirect.
        console.log('[ShopifyCallback] waiting for store hydration...');
        const { orgId: hydratedOrgId, user: hydratedUser } = await waitForStoreHydration(3000);
        console.log('[ShopifyCallback] hydration result', { hydratedOrgId, hydratedUser: !!hydratedUser });

        // Ensure Supabase session is valid (may have expired during OAuth redirect)
        try {
          await ensureValidSession(8000, true);
        } catch (e) {
          console.warn('[ShopifyCallback] session refresh warning:', e);
        }

        // Get current user
        const {
          data,
          error,
        } = await supabase.auth.getUser();

        if (error || !data?.user) {
          throw new Error('Not authenticated');
        }

        // If auth store doesn't have the user yet, set it now
        if (!useAuth.getState().user) {
          useAuth.getState().setUser({
            id: data.user.id,
            email: data.user.email || '',
            name: data.user.user_metadata?.name || data.user.email?.split('@')[0] || 'User',
          });
        }

        // If org store doesn't have an active org, initialize organizations
        let activeOrgId = useOrganization.getState().activeOrganizationId;
        if (!activeOrgId) {
          console.log('[ShopifyCallback] no active org — loading organizations...');
          try {
            await useOrganization.getState().loadOrganizations({ force: true });
            activeOrgId = useOrganization.getState().activeOrganizationId;
          } catch (e) {
            console.warn('[ShopifyCallback] loadOrganizations failed:', e);
          }
        }

        if (!activeOrgId) {
          throw new Error('No active organization found. Please create an organization first.');
        }

        // Exchange code for access token (Admin API token)
        const shopifyStore = await exchangeCodeForToken(shop, code);
        if (!shopifyStore) {
          throw new Error('Failed to exchange code for token');
        }

        // Save store connection to database for OAuth tracking
        const saved = await saveShopifyStore(data.user.id, shop, shopifyStore.accessToken, activeOrgId);
        if (!saved) {
          throw new Error('Failed to save store connection');
        }

        // Check if this is coming from "Add Store" dialog
        const pendingStoreJson = sessionStorage.getItem('pendingStore');
        
        // Normalize shop domain for fallback
        let normalizedShop = shop.toLowerCase();
        if (!normalizedShop.includes('.myshopify.com')) {
          normalizedShop = `${normalizedShop}.myshopify.com`;
        }
        normalizedShop = normalizedShop.replace(/^https:\/\//, '');
        
        if (pendingStoreJson) {
          try {
            const pendingStore = JSON.parse(pendingStoreJson);
            
            // Normalize domain
            let normalizedDomain = pendingStore.domain.toLowerCase();
            if (!normalizedDomain.includes('.myshopify.com')) {
              normalizedDomain = `${normalizedDomain}.myshopify.com`;
            }
            normalizedDomain = normalizedDomain.replace(/^https:\/\//, '');
            
            
            // Add the store with only admin token from OAuth
            const result = await addStore({
              name: pendingStore.name,
              domain: normalizedDomain,
              adminToken: shopifyStore.accessToken, // Admin token from OAuth exchange
            });
            
            // Clear pending store
            sessionStorage.removeItem('pendingStore');
          } catch (err) {
            console.error('Error adding store from OAuth:', err);
            throw err; // Re-throw so we catch it in the outer catch block
          }
        } else {
          // Fallback: pendingStore missing (sessionStorage cleared during redirect).
          // Create the store entry from the OAuth data so the dashboard can find it.
          console.warn('[ShopifyCallback] No pending store found — creating from OAuth data');
          try {
            const storeName = normalizedShop.replace('.myshopify.com', '');
            await addStore({
              name: storeName,
              domain: normalizedShop,
              adminToken: shopifyStore.accessToken,
            });
          } catch (err) {
            console.error('[ShopifyCallback] Fallback addStore failed:', err);
            throw err;
          }
        }

        // Force-reload stores from DB so dashboard has fresh data
        try {
          await useStoreManagement.getState().loadStores({ organizationId: activeOrgId, force: true });
        } catch (e) {
          console.warn('[ShopifyCallback] post-add loadStores failed:', e);
        }

        // Trigger an initial product sync so the dashboard isn't empty
        try {
          const latestStores = useStoreManagement.getState().stores || [];
          const storeIds = latestStores.map((s) => s.id);
          if (storeIds.length > 0) {
            console.log('[ShopifyCallback] triggering initial sync for', storeIds.length, 'stores');
            supabase.functions.invoke('sync-stores', {
              body: {
                storeIds,
                organizationId: activeOrgId,
                userId: data.user.id,
              },
            }).catch((e) => console.warn('[ShopifyCallback] background sync error:', e));
          }
        } catch (e) {
          console.warn('[ShopifyCallback] initial sync trigger failed:', e);
        }

        setStatus('success');
        // Use full page reload instead of navigate to ensure clean state
        // (all stores, auth, org are loaded fresh)
        setTimeout(() => {
          window.location.href = '/';
        }, 2000);
      } catch (err) {
        console.error('OAuth callback error:', err);
        const msg = err instanceof Error ? err.message : 'An error occurred';

        // If the error is Shopify's "code already used" page, give a friendlier
        // message and a one-click retry instead of dumping raw HTML.
        const isCodeUsed =
          msg.includes('already used') ||
          msg.includes('was not found') ||
          msg.includes('invalid_request');

        setStatus('error');
        setError(
          isCodeUsed
            ? 'The authorization code expired or was already used. Please reconnect the store.'
            : msg,
        );
      }
    };

    handleCallback();
  }, [searchParams, navigate, addStore]); // addStore is stable (Zustand selector)

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Shopify Authentication</CardTitle>
          <CardDescription>Processing your authorization...</CardDescription>
        </CardHeader>
        <CardContent>
          {status === 'processing' && (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-shopify-green" />
              <p className="text-center text-sm text-gray-600">
                Please wait while we complete your authentication...
              </p>
            </div>
          )}

          {status === 'success' && (
            <div className="flex flex-col items-center gap-4">
              <div className="h-8 w-8 rounded-full bg-green-100 flex items-center justify-center">
                <svg
                  className="h-5 w-5 text-green-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-center text-sm text-gray-600">
                Store connected successfully Redirecting you to your dashboard...
              </p>
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col items-center gap-4">
              <div className="h-8 w-8 rounded-full bg-red-100 flex items-center justify-center">
                <svg
                  className="h-5 w-5 text-red-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <p className="text-center text-sm text-red-600">
                {error || 'Authentication failed. Please try again.'}
              </p>
              <button
                onClick={() => navigate('/dashboard')}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm"
              >
                Back to Dashboard
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
