import { supabase, supabasePublic, ensureValidSession } from './supabase';

// ============= STORES =============

export async function saveStore(userId, organizationId, store) {
  try {
    
    
    // Use authenticated supabase client for write operations (required for RLS)
    // Only save fields that exist in the database
    const storeData = {
      id: store.id,
      user_id: userId,
      organization_id: organizationId,
      name: store.name,
      domain: store.domain,
      storefront_token: store.storefrontToken || store.storefront_token,
      admin_token: store.adminToken || store.admin_token,
      // Don't include createdAt - let the database handle it
    };

    const { error } = await supabase
      .from('stores')
      .upsert(storeData, { onConflict: 'id' });

    if (error) {
      console.error('[saveStore] Error:', error);
      throw error;
    }
    
    
  } catch (error) {
    console.error('[saveStore] Error saving store:', error);
    throw error;
  }
}

export async function getStores(userId, organizationId) {
  try {
    
    
    // Add timeout to prevent hanging. Use AUTH_TIMEOUT_MS so it's aligned
    // with other auth operations (user requested longer validation window).
    const { AUTH_TIMEOUT_MS } = await import('./supabase');
    // Use a slightly larger timeout for store listing to tolerate slower
    // responses on free-tier or cold-start databases.
    const effectiveTimeout = Math.max(AUTH_TIMEOUT_MS, 15_000);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`getStores timeout after ${effectiveTimeout}ms`)), effectiveTimeout)
    );

    // Use authenticated supabase client (required for RLS)
    // The supabase client handles session automatically
    const queryPromise = supabase
      .from('stores')
      .select('*')
      .eq('organization_id', organizationId); 

    const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

    if (error) {
      // Check if it's an AbortError - don't log these happen during re-renders
      const errorMsg = error.message || String(error);
      const isAbort = errorMsg.includes('abort') || 
                     errorMsg.includes('AbortError') || 
                     errorMsg.includes('signal is aborted') ||
                     error.name === 'AbortError';
      if (isAbort) {
        
        return [];
      }
      
      console.error('[getStores] Query error:', error);
      // If it's an auth error, try to refresh the session
      if (error.message?.includes('JWT') || error.code === 'PGRST301') {
        
        const session = await ensureValidSession(3000);
        if (!session) {
          console.error('[getStores] Could not refresh session');
          return [];
        }
        // Retry the query once after session refresh
        const { data, error: retryError } = await supabase
          .from('stores')
          .select('*')
          .eq('organization_id', organizationId);
        
        if (retryError) {
          console.error('[getStores] Retry failed:', retryError);
          return [];
        }
        
        return (data || []).map((store) => ({
          id: store.id,
          organizationId: store.organization_id,
          name: store.name,
          domain: store.domain,
          storefrontToken: store.storefront_token,
          adminToken: store.admin_token,
          createdAt: store.created_at,
        }));
      }
      throw error;
    }
    
    
    
    return (data || []).map((store) => ({
      id: store.id,
      organizationId: store.organization_id,
      name: store.name,
      domain: store.domain,
      storefrontToken: store.storefront_token,
      adminToken: store.admin_token,
      createdAt: store.created_at,
    }));
  } catch (error) {
    // Don't log AbortErrors - they happen during rapid re-renders
    const errorMessage = (error)?.message || String(error);
    if (errorMessage.includes('abort') || errorMessage.includes('AbortError')) {
      
      return [];
    }
    console.error('[getStores] Error:', error);
    return [];
  }
}

export async function updateStoreInSupabase(userId, organizationId, storeId, updates) {
  try {
    // Map camelCase keys to snake_case DB columns
    const dbUpdates = {};
    if (updates.adminToken   !== undefined) dbUpdates.admin_token       = updates.adminToken;
    if (updates.admin_token  !== undefined) dbUpdates.admin_token       = updates.admin_token;
    if (updates.storefrontToken !== undefined) dbUpdates.storefront_token = updates.storefrontToken;
    if (updates.storefront_token !== undefined) dbUpdates.storefront_token = updates.storefront_token;
    if (updates.name         !== undefined) dbUpdates.name              = updates.name;
    if (updates.domain       !== undefined) dbUpdates.domain            = updates.domain;

    const { error } = await supabase
      .from('stores')
      .update(dbUpdates)
      .eq('id', storeId)
      .eq('organization_id', organizationId);

    if (error) throw error;
  } catch (error) {
    console.error('Error updating store:', error);
    throw error;
  }
}

export async function deleteStoreFromSupabase(userId, organizationId, storeId) {
  try {
    
    
    // First, get counts of what will be deleted
    const { data: productData } = await supabase
      .from('shopify_products')
      .select('id', { count: 'exact' })
      .eq('store_id', storeId);
    
    const productCount = productData?.length || 0;
    
    
    
    // Delete the store (CASCADE will delete all related data)
    const { error } = await supabase
      .from('stores')
      .delete()
      .eq('id', storeId)
      .eq('organization_id', organizationId);

    if (error) {
      console.error('[deleteStoreFromSupabase] Error:', error);
      throw error;
    }
    
    
  } catch (error) {
    console.error('[deleteStoreFromSupabase] Error deleting store:', error);
    throw error;
  }
}

// ============= REPORTS =============

export async function saveReport(userId, organizationId, report) {
  try {
    // Map camelCase to snake_case for database
    // codeStatOrder has no dedicated column — embed it inside the filters JSONB
    const { createdAt, updatedAt, selectedColumns, filterConfig, shareLink, storeId, storeName, organizationId: _orgId, codeStatOrder, customCode, ...reportData } = report;
    
    const filtersPayload = {
      ...(filterConfig || {}),
      ...(Array.isArray(codeStatOrder) && codeStatOrder.length ? { __codeStatOrder: codeStatOrder } : {}),
      ...(customCode ? { __customCode: customCode } : {}),
    };

    const { error } = await supabase
      .from('reports')
      .upsert({ 
        ...reportData,
        user_id: userId,
        organization_id: organizationId,
        selected_columns: selectedColumns,
        filters: filtersPayload, // Maps filterConfig + codeStatOrder to 'filters' column
        share_link: shareLink,
        store_id: storeId,
        store_name: storeName,
        created_at: createdAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) throw error;
  } catch (error) {
    console.error('Error saving report:', error);
    
    // Check for network-level failures
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      throw new Error('Could not reach the server. Please check your internet connection and try again.');
    }
    
    throw error;
  }
}

export async function getReports(userId, organizationId) {
  try {
    const query = supabase
      .from('reports')
      .select('*')
      .eq('organization_id', organizationId);

    const { data, error } = await query;

    if (error) throw error;
    
    // Map snake_case back to camelCase
    return (data || []).map(report => {
      const rawFilters = report.filters || {};
      const { __codeStatOrder, __customCode, ...filterItems } = rawFilters;
      return {
        ...report,
        selectedColumns: report.selected_columns || [],
        filterConfig: filterItems,
        codeStatOrder: Array.isArray(__codeStatOrder) ? __codeStatOrder : null,
        customCode: __customCode || null,
        createdAt: report.created_at,
        updatedAt: report.updated_at,
        storeId: report.store_id,
        storeName: report.store_name,
        shareLink: report.share_link,
        organizationId: report.organization_id,
      };
    });
  } catch (error) {
    console.error('Error getting reports:', error);
    return [];
  }
}

export async function getReportByShareLink(shareLink) {
  
  try {
    // Use supabasePublic (anon client) so anonymous users can fetch report metadata
    // without needing an authenticated session
    const { data, error } = await supabasePublic
      .from('reports')
      .select('*')
      .eq('share_link', shareLink)
      .single();

    
    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows returned
    
    if (!data) {
      
      return null;
    }
    
    
    // Map snake_case back to camelCase
    const rawFilters = data.filters || {};
    const { __codeStatOrder, __customCode, ...filterItems } = rawFilters;
    return {
      ...data,
      selectedColumns: data.selected_columns || [],
      filterConfig: filterItems,
      codeStatOrder: Array.isArray(__codeStatOrder) ? __codeStatOrder : null,
      customCode: __customCode || null,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      storeId: data.store_id,
      storeName: data.store_name,
      shareLink: data.share_link,
      organizationId: data.organization_id,
    };
  } catch (error) {
    console.error('[getReportByShareLink] Error:', error);
    return null;
  }
}

export async function deleteReportFromSupabase(userId, organizationId, reportId) {
  try {
    
    const { data, error } = await supabase
      .from('reports')
      .delete()
      .eq('id', reportId)
      .eq('organization_id', organizationId)
      .select();

    if (error) {
      console.error('[deleteReportFromSupabase] Error:', error);
      throw error;
    }
    
    
    if (!data || data.length === 0) {
      console.warn('[deleteReportFromSupabase] No rows deleted - report may not exist or RLS policy blocked');
    }
  } catch (error) {
    console.error('Error deleting report:', error);
    throw error;
  }
}

// ============= COLUMN PREFERENCES =============

export async function saveColumnPreferences(userId, preferences) {
  try {
    // Convert Map to array for storage
    const prefsArray = Array.from(preferences.values());

    const { error } = await supabase
      .from('column_preferences')
      .upsert(
        {
          user_id: userId,
          preferences: prefsArray,
        },
        { onConflict: 'user_id' }
      );

    if (error) throw error;
  } catch (error) {
    console.error('Error saving column preferences:', error);
    throw error;
  }
}

export async function getColumnPreferences(userId) {
  try {
    const { data, error } = await supabase
      .from('column_preferences')
      .select('preferences')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!data?.preferences || !Array.isArray(data.preferences)) {
      return new Map();
    }

    const prefsMap = new Map(
      data.preferences.map((pref) => [
        pref.key,
        { key: pref.key, visible: pref.visible, order: pref.order },
      ])
    );

    return prefsMap;
  } catch (error) {
    console.error('Error getting column preferences:', error);
    return new Map();
  }
}

// ============= ORGANIZATIONS =============

export async function getOrganizationsForUser(userId) {
  
  try {
    
    const { data, error } = await supabase
      .from('organization_members')
      .select('role, organization:organizations(id, name, created_at)')
      .eq('user_id', userId);

    
    if (error) throw error;

    const orgs = (data || [])
      .map((row) => {
        if (!row.organization) return null;
        return {
          id: row.organization.id,
          name: row.organization.name,
          created_at: row.organization.created_at,
          role: row.role,
        };
      })
      .filter(Boolean);
    
    
    return orgs;
  } catch (error) {
    console.error('[getOrganizationsForUser] Error loading organizations:', error);
    return [];
  }
}

export async function createOrganizationForUser(userId, name) {
  const { data, error } = await supabase
    .from('organizations')
    .insert({ name, created_by: userId })
    .select('id, name, created_at')
    .single();

  if (error) {
    console.error('[createOrganizationForUser] Error creating organization:', error);
    throw error;
  }

  const { error: memberError } = await supabase
    .from('organization_members')
    .insert({ organization_id: data.id, user_id: userId, role: 'admin' });

  if (memberError) {
    console.error('[createOrganizationForUser] Error adding member:', memberError);
    throw memberError;
  }

  // Backfill existing user data into this organization if it hasn't been assigned yet
  // These updates should not fail for new users (they have no data yet)
  const backfillResults = await Promise.allSettled([
    supabase.from('stores').update({ organization_id: data.id }).eq('user_id', userId).is('organization_id', null),
    supabase.from('reports').update({ organization_id: data.id }).eq('user_id', userId).is('organization_id', null),
    supabase.from('shopify_products').update({ organization_id: data.id }).eq('user_id', userId).is('organization_id', null),
    supabase.from('shopify_store_sync_status').update({ organization_id: data.id }).eq('user_id', userId).is('organization_id', null),
  ]);

  // Log any backfill errors but don't throw (they're non-critical for new users)
  backfillResults.forEach((result, index) => {
    const tables = ['stores', 'reports', 'shopify_products', 'shopify_store_sync_status'];
    if (result.status === 'rejected') {
      console.warn(`[createOrganizationForUser] Backfill failed for ${tables[index]}:`, result.reason);
    }
  });

  return {
    id: data.id,
    name: data.name,
    created_at: data.created_at,
    role: 'admin',
  };
}

export async function deleteOrganization(userId, organizationId) {
  // First verify the user is an admin of this organization
  const { data, error: memberError } = await supabase
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .single();

  if (memberError || !data) {
    throw new Error('You are not a member of this organization');
  }

  if (data.role !== 'admin') {
    throw new Error('Only admins can delete an organization');
  }

  // Delete the organization - CASCADE will delete related data
  // (stores, reports, products, members, sync status)
  const { error } = await supabase
    .from('organizations')
    .delete()
    .eq('id', organizationId);

  if (error) {
    console.error('[deleteOrganization] Error:', error);
    throw error;
  }

  
}

export async function getOrganizationMembers(organizationId) {
  const { data, error } = await supabase
    .from('organization_members')
    .select('user_id, role, created_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true });

  if (error) throw error;

  const userIds = (data || []).map((row) => row.user_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, email')
    .in('id', userIds);

  const emailMap = new Map((profiles || []).map((p) => [p.id, p.email]));

  return (data || []).map((row) => ({
    user_id: row.user_id,
    role: row.role,
    created_at: row.created_at,
    email: emailMap.get(row.user_id) || 'unknown',
  }));
}

export async function addOrganizationMemberByEmail(
  organizationId,
  email,
  role
) {
  const { data, error: profileError } = await supabase
    .from('profiles')
    .select('id, email')
    .eq('email', email)
    .maybeSingle();

  if (profileError) {
    console.error('[addOrganizationMemberByEmail] Error querying profile:', profileError);
    throw new Error('Error looking up user profile.');
  }

  if (!data) {
    throw new Error('User not found. Ask them to sign up first.');
  }

  const { error } = await supabase
    .from('organization_members')
    .insert({ organization_id: organizationId, user_id: data.id, role });

  if (error) throw error;
}

export async function updateOrganizationMemberRole(
  organizationId,
  userId,
  role
) {
  const { error } = await supabase
    .from('organization_members')
    .update({ role })
    .eq('organization_id', organizationId)
    .eq('user_id', userId);

  if (error) throw error;
}

export async function removeOrganizationMember(organizationId, userId) {
  const { error } = await supabase
    .from('organization_members')
    .delete()
    .eq('organization_id', organizationId)
    .eq('user_id', userId);

  if (error) throw error;
}

// NOTE: All product sync functions moved to shopify-sync-utils.ts
// - getCachedProductsByStoreIds ? getVariantsByStore
// - upsertCachedProducts ? upsertProducts (normalized schema)
// - deleteMissingCachedProducts ? markDeletedProducts (soft delete)
// - getStoreSyncStatus ? getSyncStatus
// - upsertStoreSyncStatus ? updateSyncStatus

// ============= CUSTOM COLUMNS =============

export async function getCustomColumns(userId, organizationId) {
  let query = supabase
    .from('custom_columns')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true });

  if (organizationId) {
    query = query.eq('organization_id', organizationId);
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data || []).map((col) => ({
    id: col.id,
    userId: col.user_id,
    organizationId: col.organization_id,
    name: col.name,
    formula: col.formula,
    position: col.position,
    createdAt: col.created_at,
  }));
}

export async function saveCustomColumn(userId, organizationId, { name, formula, position }) {
  const { data, error } = await supabase
    .from('custom_columns')
    .insert({
      user_id: userId,
      organization_id: organizationId || null,
      name,
      formula,
      position: position ?? 0,
    })
    .select()
    .single();

  if (error) throw error;

  return {
    id: data.id,
    userId: data.user_id,
    organizationId: data.organization_id,
    name: data.name,
    formula: data.formula,
    position: data.position,
    createdAt: data.created_at,
  };
}

export async function deleteCustomColumn(columnId, userId) {
  const { error } = await supabase
    .from('custom_columns')
    .delete()
    .eq('id', columnId)
    .eq('user_id', userId);

  if (error) throw error;
}
