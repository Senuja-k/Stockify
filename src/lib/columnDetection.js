import { COLUMN_CONFIG } from '@/lib/columnConfig';

/**
 * Recursively scan products to detect available fields and their types
 */
export function detectProductFields(products) {
  if (products.length === 0) {
    return getDefaultColumns();
  }

  const fieldMap = new Map();
  
  // Sample first product for field detection
  const sample = products[0];
  
  // Check if we have Admin API data (has metafields)
  let hasBarcode = false;
  if (sample.variants) {
    const variantArray = Array.isArray(sample.variants) ? sample.variants : (sample.variants).edges?.map((e) => e.node) || [];
    hasBarcode = variantArray.some((v) => v?.hasOwnProperty('barcode'));
  }

  // Scan first product for basic fields
  const scanObject = (obj, prefix = '', depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 3) return; // Limit depth to avoid infinite recursion

    for (const [key, value] of Object.entries(obj)) {
      // Skip internal/complex fields
      if (key.startsWith('_') || key === 'id' || key === 'storeId') continue;

      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (value === null || value === undefined) continue;

      // Detect field type
      if (Array.isArray(value)) {
        // Skip metafields and variants here - we'll handle them separately below
        if (key === 'metafields' || key === 'variants') {
          continue;
        }
        // For other arrays, continue without processing
        continue;
      } else if (typeof value === 'string') {
        // Check if it looks like a date
        if (key.includes('At') && !fieldMap.has(fullKey)) {
          fieldMap.set(fullKey, 'date');
        } else if (key.includes('Price') || key.includes('Amount')) {
          fieldMap.set(fullKey, 'currency');
        } else if (!fieldMap.has(fullKey)) {
          fieldMap.set(fullKey, 'string');
        }
      } else if (typeof value === 'number') {
        if (!fieldMap.has(fullKey)) {
          fieldMap.set(fullKey, 'number');
        }
      } else if (typeof value === 'object' && value !== null) {
        // For nested objects, scan them (but skip variants, images, metafields, and raw
        // Shopify API wrappers that create conflicting/duplicate column names)
        if (key !== 'variants' && key !== 'images' && key !== 'metafields' &&
            key !== 'variantData' && key !== 'fullProduct') {
          scanObject(value, fullKey, depth + 1);
        }
      }
    }
  };

  scanObject(sample);

  // Scan ALL products for metafields (not just first one) to collect all possible metafield keys
  const allMetafieldKeys = new Set();
  products.forEach((product, index) => {
    if (product.metafields && Array.isArray(product.metafields)) {
      product.metafields.forEach((meta) => {
        if (meta && meta.key) {
          allMetafieldKeys.add(meta.key);
        }
      });
    }
  });

  // Add all discovered metafield keys to fieldMap
  allMetafieldKeys.forEach((key) => {
    const metaKey = `metafield.${key}`;
    fieldMap.set(metaKey, 'string');
  });

  // Check variants for variant-specific fields (SKU, barcode, price, compareAtPrice)
  // Since products are already flattened, look for variantSku, variantBarcode, variantPrice, compareAtPrice
  let hasVariantSku = false;
  let hasVariantBarcode = false;
  let hasVariantPrice = false;
  let hasCompareAtPrice = false;
  
  products.forEach((product) => {
    if (product.hasOwnProperty('variantSku')) hasVariantSku = true;
    if (product.hasOwnProperty('variantBarcode')) hasVariantBarcode = true;
    if (product.hasOwnProperty('variantPrice')) hasVariantPrice = true;
    if (product.hasOwnProperty('compareAtPrice')) hasCompareAtPrice = true;
  });

  if (hasVariantSku) {
    fieldMap.set('variantSku', 'string');
  }
  if (hasVariantBarcode) {
    fieldMap.set('variantBarcode', 'string');
  }
  if (hasVariantPrice) {
    fieldMap.set('variantPrice', 'currency');
  }
  if (hasCompareAtPrice) {
    fieldMap.set('compareAtPrice', 'currency');
  }

  // Convert to column definitions
  const columns = Array.from(fieldMap.entries()).map(
    ([key, type]) => ({
      key,
      label: formatColumnLabel(key),
      type,
      sortable: type !== 'object',
      filterable: type === 'string',
      hidden: shouldHideField(key),
    })
  );

  // Ensure essential columns are at the top
  const essentialColumns = getDefaultColumns();
  const essentialKeys = new Set(essentialColumns.map((c) => c.key));

  // Reorder: essential first, then others
  return [
    ...essentialColumns.filter((col) => columns.some((c) => c.key === col.key)),
    ...columns.filter((col) => !essentialKeys.has(col.key)),
  ];
}

function getDefaultColumns() {
  const defaults = [
    { key: 'title', type: 'string', sortable: true, filterable: true, width: 'min-w-[200px]' },
    { key: 'images', type: 'image', sortable: true, filterable: true, width: 'w-[80px]' },
    { key: 'vendor', type: 'string', sortable: true, filterable: true },
    { key: 'productType', type: 'string', sortable: true, filterable: true },
    { key: 'totalInventory', type: 'number', sortable: true, filterable: false },
    { key: 'createdAt', type: 'date', sortable: true, filterable: false },
    { key: 'updatedAt', type: 'date', sortable: true, filterable: false },
  ];

  // Derive labels from field names so they always match what Shopify provides
  return defaults.map((col) => ({
    ...col,
    label: formatColumnLabel(col.key),
    width: COLUMN_CONFIG.columnWidths?.[col.key] || col.width,
  }));
}

function formatColumnLabel(key) {
  // Special labels for specific fields
  if (key === 'sku') return 'SKU';
  if (key === 'barcode') return 'Barcode';
  if (key === 'price') return 'Price';
  if (key === 'variantSku') return 'Variant SKU';
  if (key === 'variantBarcode') return 'Variant Barcode';
  if (key === 'variantPrice') return 'Variant Price';
  if (key.startsWith('metafield.')) {
    const metaKey = key.replace('metafield.', '');
    return metaKey.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  }
  
  return key
    .split('.')
    .pop()
    ?.replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim() || key;
}

function shouldHideField(key) {
  const hiddenPatterns = [
    'description',
    'publishedAt',
    'handle',
    'variants',
    'priceRange', // Hide all priceRange fields
    'currencyCode',
    'edges', // Hide GraphQL edges
    'node', // Hide GraphQL node wrapper
  ];
  // Never hide metafields or variant-related fields
  // Hide 'price' but keep 'variantPrice'
  if (key.startsWith('metafield.') || key === 'sku' || key === 'barcode' || 
      key === 'variantSku' || key === 'variantBarcode' || key === 'variantPrice' || key === 'variantId' || key === 'variantTitle') {
    return false;
  }
  // Explicitly hide the 'price' field
  if (key === 'price') {
    return true;
  }
  return hiddenPatterns.some((pattern) => key.includes(pattern));
}

/**
 * Get nested value from object using dot notation
 */
export function getNestedValue(obj, path) {
  // Guard: ensure path is a valid string
  if (!path || typeof path !== 'string') {
    return undefined;
  }

  // Handle metafields specially (e.g., "metafield.title_tag")
  if (path.startsWith('metafield.')) {
    const metaKey = path.replace('metafield.', '');
    const metafields = obj.metafields;
    
    if (Array.isArray(metafields)) {
      const metafield = metafields.find((m) => m.key === metaKey);
      return metafield?.value || undefined;
    }
    return undefined;
  }

  // Handle direct property access (e.g., "variantBarcode", "store_id", "shopify_product_id")
  // Try direct access first before attempting dot notation
  if (obj.hasOwnProperty(path)) {
    return obj[path];
  }

  // Handle variant fields (SKU, barcode, price) - get from first variant if not already flattened
  if ((path === 'sku' || path === 'barcode' || path === 'price') && obj.variants) {
    const variants = obj.variants;
    if (Array.isArray(variants) && variants.length > 0) {
      return variants[0][path];
    }
    return undefined;
  }

  // Handle dot notation for nested paths (e.g., "product.title")
  if (path.includes('.')) {
    return path.split('.').reduce((current, part) => current?.[part], obj);
  }

  // Fallback to undefined if property doesn't exist
  return undefined;
}

/**
 * Format value based on column type
 */
export function formatColumnValue(value, type, currencyCode) {
  if (value === null || value === undefined) return 'N/A';

  switch (type) {
    case 'date':
      return new Date(value).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    case 'currency':
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currencyCode || 'LKR',
      }).format(parseFloat(value));
    case 'number':
      return typeof value === 'number' ? value.toString() : String(value);
    default:
      return String(value);
  }
}
