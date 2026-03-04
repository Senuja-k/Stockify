import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

serve(async (req) => {
  console.log('[public-report-data] Incoming request:', req.method)

  try {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let body
    try {
      const text = await req.text()
      body = text ? JSON.parse(text) : {}
    } catch (e) {
      console.error('[public-report-data] Failed to parse request body:', e)
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { shareLink, storeId, organizationId, storeIds } = body || {}
    console.log('[public-report-data] Request:', { shareLink, storeId, organizationId, storeIds })

    if (!shareLink) {
      return new Response(
        JSON.stringify({ error: 'Missing shareLink parameter' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('[public-report-data] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
      return new Response(
        JSON.stringify({ error: 'Server configuration error - missing environment variables' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Determine target store IDs
    let targetStoreIds = []

    if (storeId === 'all-stores' && organizationId) {
      const { data: stores, error: storesError } = await supabase
        .from('shopify_stores')
        .select('id')
        .eq('organization_id', organizationId)

      if (storesError) {
        console.error('[public-report-data] Error fetching stores:', storesError)
      } else if (Array.isArray(stores) && stores.length > 0) {
        targetStoreIds = stores.map((s) => s.id)
        console.log('[public-report-data] Found stores:', targetStoreIds)
      }
    } else if (Array.isArray(storeIds) && storeIds.length > 0) {
      targetStoreIds = storeIds
    } else if (storeId && storeId !== 'all-stores') {
      targetStoreIds = [storeId]
    }

    // Build products query
    let productsQuery = supabase.from('shopify_products').select('*')
    if (targetStoreIds.length > 0) {
      productsQuery = productsQuery.in('store_id', targetStoreIds)
    } else if (organizationId) {
      productsQuery = productsQuery.eq('organization_id', organizationId)
    }

    const { data: products, error: productsError } = await productsQuery

    if (productsError) {
      console.error('[public-report-data] Database error:', JSON.stringify(productsError))
      return new Response(
        JSON.stringify({ error: 'Failed to fetch products', details: productsError }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Fetch sync statuses (non-fatal)
    let syncQuery = supabase.from('shopify_store_sync_status').select('store_id, last_product_sync_at')
    if (targetStoreIds.length > 0) {
      syncQuery = syncQuery.in('store_id', targetStoreIds)
    } else if (organizationId) {
      syncQuery = syncQuery.eq('organization_id', organizationId)
    }

    const { data: syncStatuses, error: syncError } = await syncQuery
    if (syncError) {
      console.error('[public-report-data] Sync status error:', JSON.stringify(syncError))
    }

    // Compute latest sync time
    let lastSyncAt = null
    if (Array.isArray(syncStatuses) && syncStatuses.length > 0) {
      const syncTimes = syncStatuses.map((s) => s.last_product_sync_at).filter(Boolean)
      if (syncTimes.length > 0) {
        lastSyncAt = syncTimes.sort().at(-1) || null
      }
    }

    return new Response(
      JSON.stringify({
        products: products || [],
        lastSyncAt,
        count: (products || []).length,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('[public-report-data] Error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
