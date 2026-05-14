
// Fields to always skip during scanning (internal system / DB fields)
const SKIP_FIELDS = new Set([
  'id', '_id', 'storeId', 'store_id', 'user_id', 'organization_id',
  'shopify_product_id', 'shopify_variant_id',
  'productId', 'variantId',
  'metafields', 'variants', 'variantData', 'fullProduct',
  'priceRange', 'currencyCode', 'price',
  'images',           // GraphQL edge object – normalized to 'image' string in data loader
  'synced_at', 'db_created_at', 'db_updated_at',
]);

// Force a specific type for known fields regardless of value type
const FIELD_TYPE_OVERRIDES = {
  image:             'image',
  variantPrice:      'currency',
  compareAtPrice:    'currency',
  totalInventory:    'number',
  inventoryQuantity: 'number',
  createdAt:         'date',
  updatedAt:         'date',
  publishedAt:       'date',
  created_at:        'date',
  updated_at:        'date',
};

// Well-known fields shown first in this exact order
const FIELD_PRIORITY = [
  'image', 'title', 'vendor', 'productType', 'status',
  'variantTitle', 'variantSku', 'sku', 'variantBarcode', 'barcode',
  'variantPrice', 'compareAtPrice', 'totalInventory',
  'description', 'handle', 'storeName', 'createdAt', 'updatedAt', 'publishedAt',
];

/**
 * Fully data-driven column detection.
 * Scans every field present in the product data (including all custom metafields).
 * Only Sales Qty / Sales Amount columns are hardcoded – those are appended in
 * ProductsTable and EditReport, not here.
 */
export function detectProductFields(products) {
  if (!products || products.length === 0) return [];

  const fieldMap = new Map();

  // Sample up to 100 products for basic field detection (performance)
  const sample = products.length > 100 ? products.slice(0, 100) : products;

  sample.forEach((product) => {
    if (!product || typeof product !== 'object') return;
    for (const [key, value] of Object.entries(product)) {
      // Skip internal fields and custom/formula column keys (start with __)
      if (SKIP_FIELDS.has(key) || key.startsWith('__')) continue;
      if (value === null || value === undefined) continue;

      // Skip objects and arrays – they are either noise or handled separately
      if (Array.isArray(value) || typeof value === 'object') continue;

      if (!fieldMap.has(key)) {
        const override = FIELD_TYPE_OVERRIDES[key];
        if (override) {
          fieldMap.set(key, override);
        } else if (typeof value === 'number') {
          fieldMap.set(key, 'number');
        } else if (typeof value === 'boolean') {
          fieldMap.set(key, 'boolean');
        } else if (typeof value === 'string') {
          if ((key.endsWith('At') || key.endsWith('_at')) && value.includes('T')) {
            fieldMap.set(key, 'date');
          } else if (key.toLowerCase().includes('price') || key.toLowerCase().includes('amount')) {
            fieldMap.set(key, 'currency');
          } else {
            fieldMap.set(key, 'string');
          }
        }
      }
    }
  });

  // Scan ALL products for metafields – every unique metafield key becomes a column
  products.forEach((product) => {
    if (!product?.metafields || !Array.isArray(product.metafields)) return;
    product.metafields.forEach((meta) => {
      if (!meta?.key) return;
      const colKey = `metafield.${meta.key}`;
      if (!fieldMap.has(colKey)) {
        const mfType = meta.type || '';
        let colType = 'string';
        if (mfType.includes('integer') || mfType.includes('decimal') || mfType.includes('rating')) {
          colType = 'number';
        } else if (mfType.includes('date')) {
          colType = 'date';
        } else if (mfType.includes('money')) {
          colType = 'currency';
        }
        fieldMap.set(colKey, colType);
      }
    });
  });

  // Build column definitions
  const columns = Array.from(fieldMap.entries()).map(([key, type]) => ({
    key,
    label: formatColumnLabel(key),
    type,
    sortable: type !== 'image' && type !== 'boolean',
    filterable: type === 'string' || type === 'number' || type === 'currency',
    hidden: false,
  }));

  // Sort: priority fields first in defined order, then regular fields alpha, then metafields alpha
  return columns.sort((a, b) => {
    const pa = FIELD_PRIORITY.indexOf(a.key);
    const pb = FIELD_PRIORITY.indexOf(b.key);
    if (pa !== -1 && pb !== -1) return pa - pb;
    if (pa !== -1) return -1;
    if (pb !== -1) return 1;
    const aMeta = a.key.startsWith('metafield.');
    const bMeta = b.key.startsWith('metafield.');
    if (aMeta && !bMeta) return 1;
    if (!aMeta && bMeta) return -1;
    return a.label.localeCompare(b.label);
  });
}

function formatColumnLabel(key) {
  if (key === 'sku') return 'SKU';
  if (key === 'barcode') return 'Barcode';
  if (key === 'image') return 'Image';
  if (key === 'variantSku') return 'Variant SKU';
  if (key === 'variantBarcode') return 'Variant Barcode';
  if (key === 'variantPrice') return 'Variant Price';
  if (key === 'compareAtPrice') return 'Compare At Price';
  if (key === 'totalInventory') return 'Total Inventory';
  if (key === 'productType') return 'Product Type';
  if (key === 'variantTitle') return 'Variant Title';
  if (key === 'storeName') return 'Store';
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
