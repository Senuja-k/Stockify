import { supabase } from './supabase';

// Shopify OAuth configuration
const shopifyOAuthConfig = {
  clientId: import.meta.env.VITE_SHOPIFY_CLIENT_ID || '',
  clientSecret: import.meta.env.VITE_SHOPIFY_CLIENT_SECRET || '',
  redirectUri: import.meta.env.VITE_SHOPIFY_REDIRECT_URI || `${window.location.origin}/auth/shopify/callback`,
  scopes: [
    'write_products',
    'read_products',
    'write_inventory',
    'read_inventory',
    'read_orders',
    'read_customers',
    'read_analytics',
    'read_reports',
  ],
};

// Generate OAuth authorization URL
export function getShopifyAuthUrl(shop, state) {
  const baseUrl = `https://${shop}/admin/oauth/authorize`;
  const params = new URLSearchParams({
    client_id: shopifyOAuthConfig.clientId,
    redirect_uri: shopifyOAuthConfig.redirectUri,
    scope: shopifyOAuthConfig.scopes.join(','),
    state: state || generateState(),
  });

  return `${baseUrl}?${params.toString()}`;
}

// Generate random state for OAuth security
function generateState() {
  return Math.random().toString(36).substring(2, 15);
}

// Exchange authorization code for access token
export async function exchangeCodeForToken(shop, code) {
  try {
    // Use Supabase Edge Function to exchange code (avoids CORS issues)
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const edgeFunctionUrl = `${supabaseUrl}/functions/v1/exchange-shopify-code`;
    
    
    
    
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
    const response = await fetch(edgeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anonKey}`,
        'apikey': anonKey,
      },
      body: JSON.stringify({
        shop: shop,
        code: code,
        redirect_uri: shopifyOAuthConfig.redirectUri,
      }),
    });

    

    if (!response.ok) {
      let errorData = {};
      try {
        errorData = await response.json();
      } catch {
        const text = await response.text();
        console.error('Failed to parse error response:', text);
        errorData = { raw_error: text };
      }
      console.error('Token exchange failed:', JSON.stringify(errorData, null, 2));
      const shopifyErr = errorData.details?.error_description
        || errorData.details?.error
        || errorData.details?.errors
        || errorData.details?.raw_error
        || errorData.error
        || errorData.raw_error
        || 'Failed to exchange code for token';
      throw new Error(String(shopifyErr));
    }

    const data = await response.json();
    
    
    if (data.error) {
      console.error('Token exchange error:', data);
      throw new Error(data.error_description || data.error);
    }
    
    return {
      shop: shop,
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      refreshToken: data.refresh_token,
    };
  } catch (error) {
    console.error('Error exchanging code for token:', error);
    throw error;
  }
}

// Save Shopify store connection to Supabase
export async function saveShopifyStore(userId, shop, accessToken, organizationId) {
  try {
    const { error } = await supabase
      .from('shopify_stores')
      .upsert(
        {
          user_id: userId,
          organization_id: organizationId,
          shop: shop,
          access_token: accessToken,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'user_id,shop', // Specify the conflict columns
        }
      );

    if (error) {
      console.error('Supabase error:', error);
      throw error;
    }
    return true;
  } catch (error) {
    console.error('Error saving Shopify store:', error);
    return false;
  }
}

// Get Shopify store for user
export async function getShopifyStore(userId) {
  try {
    const { data, error } = await supabase
      .from('shopify_stores')
      .select('shop, access_token')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (data) {
      return {
        shop: data.shop,
        accessToken: data.access_token,
      };
    }

    return null;
  } catch (error) {
    console.error('Error getting Shopify store:', error);
    return null;
  }
}

// Verify Shopify webhook (optional)
export function verifyShopifyWebhook(req, secret) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const body = req.rawBody;

  if (!hmac || !body) {
    return false;
  }

  const hash = require('crypto')
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');

  return hash === hmac;
}

// Make authenticated request to Shopify API
export async function makeShopifyRequest(shop, accessToken, endpoint, options = {}) {
  try {
    const url = `https://${shop}/admin/api/2024-01/graphql.json`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      ...options,
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error making Shopify request:', error);
    throw error;
  }
}

// Example: Get shop info from Shopify
export async function getShopInfo(shop, accessToken) {
  const query = `
    {
      shop {
        name
        email
        plan {
          displayName
        }
      }
    }
  `;

  return makeShopifyRequest(shop, accessToken, '', {
    body: JSON.stringify({ query }),
  });
}
