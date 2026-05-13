import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

serve(async (req) => {
  console.log('[shopify-admin-api] Incoming request:', req.method)
  
  try {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Parse request body
    let body
    try {
      const text = await req.text()
      console.log('[shopify-admin-api] Request body length:', text.length)
      body = JSON.parse(text)
    } catch (e) {
      console.error('[shopify-admin-api] Failed to parse request body:', e)
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { shop, query, variables, accessToken, apiVersion } = body
    
    console.log('[shopify-admin-api] Shop:', shop, 'AccessToken present:', !!accessToken)

    if (!shop || !query || !accessToken) {
      return new Response(
        JSON.stringify({ error: 'Missing shop, query, or accessToken parameter' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Build the URL — caller can override API version (e.g. 2024-10 for shopifyqlQuery)
    const resolvedVersion = apiVersion || '2025-07';
    const adminUrl = `https://${shop}/admin/api/${resolvedVersion}/graphql.json`
    console.log('[shopify-admin-api] Requesting:', adminUrl)

    // Headers for the Shopify Admin API request
    const shopifyHeaders = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    }

    // Make the Admin API request
    const adminResponse = await fetch(adminUrl, {
      method: 'POST',
      headers: shopifyHeaders,
      body: JSON.stringify({ query, variables }),
    })

    console.log('[shopify-admin-api] Shopify response status:', adminResponse.status)

    if (!adminResponse.ok) {
      const errorText = await adminResponse.text()
      console.error('[shopify-admin-api] Shopify error response:', errorText.substring(0, 500))
      
      let errorData = {}
      try {
        errorData = JSON.parse(errorText)
      } catch {
        errorData = { raw_error: errorText.substring(0, 200) }
      }
      
      return new Response(
        JSON.stringify({
          error: 'Failed to fetch from Shopify Admin API',
          details: errorData,
        }),
        {
          status: adminResponse.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // Parse response
    let responseData
    try {
      responseData = await adminResponse.json()
    } catch (e) {
      console.error('[shopify-admin-api] Failed to parse response:', e)
      return new Response(
        JSON.stringify({ error: 'Invalid response from Shopify' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('[shopify-admin-api] Request successful')
    return new Response(
      JSON.stringify(responseData),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('[shopify-admin-api] Unhandled error:', error)
    
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
