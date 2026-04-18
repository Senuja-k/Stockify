/**
 * Server-side query helpers for paginated, filtered product queries.
 *
 * All queries go against the `shopify_products` table whose data lives
 * inside a JSONB `data` column.
 *
 * ✅ Performance improvements:
 * - NO ensureValidSession() calls here (Supabase client already manages tokens)
 * - Use count: 'estimated' for fast pagination
 * - Select ONLY columns needed by UI (avoid '*')
 * - Abort signal supported but optional
 */

import { supabase, refreshSessionSilently } from "./supabase";

// ---------------------------------------------------------------------------
// Retry wrapper for transient failures (auth expiry, connection drops)
// ---------------------------------------------------------------------------

function isRetryableError(err) {
  if (!err) return false;
  const msg = String(err.message || err.details || err || "").toLowerCase();
  return (
    msg.includes("jwt") ||
    msg.includes("token") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("gateway")
  );
}

/**
 * Runs a Supabase query function with automatic retry on auth/network errors.
 * On first failure it silently refreshes the session and retries once.
 */
async function withRetry(queryFn, label = "query") {
  try {
    return await queryFn();
  } catch (err) {
    if (!isRetryableError(err)) throw err;
    console.warn(`[serverQueries] ${label} failed with retryable error, refreshing session and retrying...`);
    const refreshed = await refreshSessionSilently(8000);
    if (!refreshed) {
      console.warn(`[serverQueries] Session refresh failed, rethrowing original error`);
      throw err;
    }
    return await queryFn();
  }
}

// ---------------------------------------------------------------------------
// Filter → Supabase query translation
// ---------------------------------------------------------------------------

function applyConditionToQuery(query, condition) {
  const col = `data->>${condition.field}`;
  const val = condition.value ?? "";
  const val2 = condition.value2 ?? "";

  switch (condition.operator) {
    // ---- String operators ----
    case "equals":
      return query.ilike(col, val);
    case "not_equals":
      return query.not(col, "ilike", val);
    case "contains":
      return query.ilike(col, `%${val}%`);
    case "not_contains":
      return query.not(col, "ilike", `%${val}%`);
    case "starts_with":
      return query.ilike(col, `${val}%`);
    case "ends_with":
      return query.ilike(col, `%${val}`);

    // ---- Numeric / date operators (string compare; OK for most cases) ----
    case "greater_than":
      return query.gt(col, val);
    case "less_than":
      return query.lt(col, val);
    case "greater_than_or_equal":
      return query.gte(col, val);
    case "less_than_or_equal":
      return query.lte(col, val);
    case "between":
      return query.gte(col, val).lte(col, val2);

    // ---- List operators ----
    case "in_list": {
      const list = condition.valueList || [];
      if (list.length === 0) return query;
      return query.in(col, list);
    }

    // ---- Blank checks ----
    case "is_blank":
      return query.is(col, null);
    case "is_not_blank":
      return query.not(col, "is", null);

    default:
      console.warn(`[serverQueries] Unknown operator: ${condition.operator}`);
      return query;
  }
}

function conditionToPostgrestString(condition) {
  const col = `data->>${condition.field}`;
  const val = condition.value ?? "";
  const val2 = condition.value2 ?? "";

  switch (condition.operator) {
    case "equals":
      return `${col}.ilike.${val}`;
    case "not_equals":
      return `${col}.not.ilike.${val}`;
    case "contains":
      return `${col}.ilike.%${val}%`;
    case "not_contains":
      return `${col}.not.ilike.%${val}%`;
    case "starts_with":
      return `${col}.ilike.${val}%`;
    case "ends_with":
      return `${col}.ilike.%${val}`;
    case "greater_than":
      return `${col}.gt.${val}`;
    case "less_than":
      return `${col}.lt.${val}`;
    case "greater_than_or_equal":
      return `${col}.gte.${val}`;
    case "less_than_or_equal":
      return `${col}.lte.${val}`;
    case "between":
      return `and(${col}.gte.${val},${col}.lte.${val2})`;
    case "in_list": {
      const list = (condition.valueList || []).join(",");
      return `${col}.in.(${list})`;
    }
    case "is_blank":
      return `${col}.is.null`;
    case "is_not_blank":
      return `${col}.not.is.null`;
    default:
      return `${col}.ilike.%${val}%`;
  }
}

function applyFiltersToQuery(query, filterConfig) {
  if (!filterConfig?.items?.length) return query;

  const conditions = [];
  const logicOps = [];

  for (const item of filterConfig.items) {
    if (typeof item === "object" && item && "id" in item) {
      conditions.push(item);
    } else if (typeof item === "string") {
      logicOps.push(item);
    }
  }

  if (conditions.length === 0) return query;

  const hasOr = logicOps.includes("OR");

  if (!hasOr) {
    for (const cond of conditions) query = applyConditionToQuery(query, cond);
    return query;
  }

  // Mixed AND/OR: evaluate left-to-right, build OR groups
  const orParts = [];
  let andGroup = [conditions[0]];

  for (let i = 1; i < conditions.length; i++) {
    const op = logicOps[i - 1] || "AND";
    if (op === "OR") {
      orParts.push(andGroup);
      andGroup = [conditions[i]];
    } else {
      andGroup.push(conditions[i]);
    }
  }
  orParts.push(andGroup);

  if (orParts.length === 1) {
    for (const cond of orParts[0]) query = applyConditionToQuery(query, cond);
    return query;
  }

  const orExpressions = orParts.map((group) => {
    if (group.length === 1) return conditionToPostgrestString(group[0]);
    const andExprs = group.map(conditionToPostgrestString);
    return `and(${andExprs.join(",")})`;
  });

  return query.or(orExpressions.join(","));
}

// ---------------------------------------------------------------------------
// Sorting helper
// ---------------------------------------------------------------------------

function applySortToQuery(query, sortField, sortDirection) {
  // Always enforce deterministic order for stable pagination.
  // Without this, range-based paging can return overlapping/missing rows.
  if (!sortField || !sortDirection) {
    return query.order("id", { ascending: true, nullsFirst: false });
  }

  const col = `data->>${sortField}`;
  return query
    .order(col, {
      ascending: sortDirection === "asc",
      nullsFirst: false,
    })
    .order("id", { ascending: true, nullsFirst: false });
}

// ---------------------------------------------------------------------------
// Base query builder
// ---------------------------------------------------------------------------

function buildBaseQuery(
  selectExpr,
  storeIds,
  organizationId,
  userId,
  filterConfig,
  signal,
  options = {},
) {
  let query = supabase.from("shopify_products").select(selectExpr, options);

  // store filter
  query = query.in("store_id", storeIds);

  // org or user scope
  if (organizationId) query = query.eq("organization_id", organizationId);
  else query = query.eq("user_id", userId);

  // optional abort signal
  if (signal) query = query.abortSignal(signal);

  // filters
  query = applyFiltersToQuery(query, filterConfig);
  return query;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a single page of products.
 *
 * ✅ Fast:
 * - count: 'estimated'
 * - minimal select
 */
export async function queryProductsPage({
  userId,
  storeIds,
  organizationId,
  filterConfig,
  sortField,
  sortDirection,
  pageIndex = 0,
  pageSize = 25,
  signal,
  includeCount = true,
  totalCountHint = 0,
}) {
  return withRetry(async () => {
    const from = pageIndex * pageSize;
    const to = from + pageSize - 1;

    let dataQuery = buildBaseQuery(
      "id, store_id, shopify_product_id, shopify_variant_id, data",
      storeIds,
      organizationId,
      userId,
      filterConfig,
      signal,
    );

    dataQuery = applySortToQuery(dataQuery, sortField, sortDirection);
    dataQuery = dataQuery.range(from, to);

    let totalCount = totalCountHint || 0;
    let dataResult;

    if (includeCount) {
      const countQuery = buildBaseQuery(
        "id",
        storeIds,
        organizationId,
        userId,
        filterConfig,
        signal,
        { count: "estimated", head: true },
      );

      const [countResult, pageResult] = await Promise.all([countQuery, dataQuery]);
      if (countResult.error) throw countResult.error;
      totalCount = countResult.count ?? 0;
      dataResult = pageResult;
    } else {
      dataResult = await dataQuery;
    }

    if (dataResult.error) throw dataResult.error;

    const pageCount = Math.ceil(totalCount / pageSize);

    return { data: formatRows(dataResult.data || []), totalCount, pageCount };
  }, "queryProductsPage");
}

/**
 * Stats for cards.
 *
 * ⚠️ Note:
 * If your dataset is big, this can still be heavy because it loads ALL matching rows.
 * Later we can replace this with a SQL RPC for instant stats.
 */
export async function queryProductStats({
  userId,
  storeIds,
  organizationId,
  filterConfig,
  signal,
}) {
  return withRetry(async () => {
    let query = buildBaseQuery(
      "store_id, data",
      storeIds,
      organizationId,
      userId,
      filterConfig,
      signal,
      { count: "estimated" },
    );

    const { data, count, error } = await query;

    if (error) {
      // abort-safe
      if (
        String(error.message || "")
          .toLowerCase()
          .includes("abort") ||
        String(error.name || "") === "AbortError"
      ) {
        return {
          totalProducts: 0,
          totalStores: 0,
          totalVendors: 0,
          totalTypes: 0,
          avgPrice: 0,
        };
      }
      throw error;
    }

    const rows = data || [];
  const vendors = new Set();
  const types = new Set();
  const storeSet = new Set();
  let priceSum = 0;
  let priceCount = 0;

  for (const row of rows) {
    const d = row.data || {};
    if (d.vendor) vendors.add(d.vendor);
    if (d.productType) types.add(d.productType);
    storeSet.add(row.store_id);

    const price = parseFloat(d.variantPrice || d.price || d.variantData?.price || "0");
    if (!isNaN(price) && price > 0) {
      priceSum += price;
      priceCount += 1;
    }
  }

  // Prefer actual rows.length over estimated count (which can be stale/0)
  const actualTotal = rows.length > 0 ? rows.length : (count || 0);

  return {
    totalProducts: actualTotal,
    totalStores: storeSet.size,
    totalVendors: vendors.size,
    totalTypes: types.size,
    avgPrice: priceCount > 0 ? priceSum / priceCount : 0,
    _rowCount: rows.length, // internal: actual rows fetched (for session health check)
  };
  }, "queryProductStats");
}

/**
 * Fetch ALL products for export.
 */
export async function queryAllFilteredProducts({
  userId,
  storeIds,
  organizationId,
  filterConfig,
  sortField,
  sortDirection,
  signal,
}) {
  const countQuery = buildBaseQuery(
    "id",
    storeIds,
    organizationId,
    userId,
    filterConfig,
    signal,
    { count: "estimated", head: true },
  );

  // Helper to detect abort-like failures (transient network/gateway/timeouts)
  const isAbortLikeLocal = (err) => {
    if (!err) return false;
    const msg = String(err.message || err.details || err || "").toLowerCase();
    return (
      String(err.name || "").toLowerCase().includes("abort") ||
      msg.includes("abort") ||
      msg.includes("timeout") ||
      msg.includes("gateway") ||
      msg.includes("502") ||
      msg.includes("failed to fetch")
    );
  };

  let countResult;
  try {
    countResult = await countQuery;
  } catch (err) {
    if (!isAbortLikeLocal(err)) throw err;
    // Retry the count query without passing the caller's signal in case
    // it was aborted externally.
    try {
      const retryCountQuery = buildBaseQuery(
        "id",
        storeIds,
        organizationId,
        userId,
        filterConfig,
        undefined,
        { count: "estimated", head: true },
      );
      countResult = await retryCountQuery;
    } catch (err2) {
      throw err2;
    }
  }

  const { count, error: countError } = countResult || {};
  if (countError) throw countError;

  const total = count || 0;
  if (total === 0) return [];
  // Strategy: attempt a higher-throughput fetch first. If an Abort-like
  // error occurs (timeout/gateway/proxy abort), retry with reduced
  // concurrency/batch size and finally fall back to sequential batches.
  const makeAttempt = async (batchSize, maxConcurrent, useSignal) => {
    const totalBatches = Math.ceil(total / batchSize);
    const allProducts = [];

    for (
      let groupStart = 0;
      groupStart < totalBatches;
      groupStart += maxConcurrent
    ) {
      const groupEnd = Math.min(groupStart + maxConcurrent, totalBatches);
      const batchPromises = [];

      for (let i = groupStart; i < groupEnd; i++) {
        const from = i * batchSize;
        const to = from + batchSize - 1;

        const fetchBatch = async () => {
          let q = buildBaseQuery(
            "id, store_id, shopify_product_id, shopify_variant_id, data",
            storeIds,
            organizationId,
            userId,
            filterConfig,
            useSignal ? signal : undefined,
          );
          q = applySortToQuery(q, sortField, sortDirection);
          q = q.range(from, to);

          const { data, error } = await q;
          if (error) throw error;
          return formatRows(data || []);
        };

        batchPromises.push(fetchBatch());
      }

      const results = await Promise.all(batchPromises);
      for (const batch of results) allProducts.push(...batch);
    }

    return allProducts;
  };

  const isAbortLike = (err) => {
    if (!err) return false;
    const msg = String(err.message || err.details || err || "").toLowerCase();
    return (
      String(err.name || "").toLowerCase().includes("abort") ||
      msg.includes("abort") ||
      msg.includes("timeout") ||
      msg.includes("gateway") ||
      msg.includes("502") ||
      msg.includes("failed to fetch")
    );
  };

  // First attempt: conservative parameters to avoid server timeouts
  try {
    return await makeAttempt(500, 2, true);
  } catch (err) {
    if (!isAbortLike(err)) throw err;
    // Retry with even smaller batches and single-threaded fetch without
    // the caller-provided signal (in case the original signal was aborted).
    try {
      return await makeAttempt(250, 1, false);
    } catch (err2) {
      if (!isAbortLike(err2)) throw err2;
      // Final fallback: sequential batches (slow but most reliable)
      const finalList = [];
      const finalBatchSize = 100;
      const finalTotalBatches = Math.ceil(total / finalBatchSize);
      for (let i = 0; i < finalTotalBatches; i++) {
        const from = i * finalBatchSize;
        const to = from + finalBatchSize - 1;
        let q = buildBaseQuery(
          "id, store_id, shopify_product_id, shopify_variant_id, data",
          storeIds,
          organizationId,
          userId,
          filterConfig,
          undefined,
        );
        q = applySortToQuery(q, sortField, sortDirection);
        q = q.range(from, to);
        const { data, error } = await q;
        if (error) throw error;
        finalList.push(...formatRows(data || []));
      }
      return finalList;
    }
  }
}

// ---------------------------------------------------------------------------
// Row formatter
// ---------------------------------------------------------------------------

function formatRows(rows) {
  return rows.map((row) => {
    const d = row.data || {};
    return {
      ...d,
      id: row.id || d.id,
      store_id: row.store_id,
      shopify_product_id: row.shopify_product_id,
      shopify_variant_id: row.shopify_variant_id,
      status: d.status || "UNKNOWN",
      variantPrice: d.variantPrice || d.price || d.variantData?.price,
      compareAtPrice: d.compareAtPrice || d.variantData?.compareAtPrice,
      variants: [],
    };
  });
}
