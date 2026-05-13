import * as XLSX from 'xlsx';
import { getNestedValue } from './columnDetection';

/**
 * Safely evaluate a custom column formula against a product row.
 * Returns the plain string value (strips color metadata).
 */
function evaluateCustomFormula(formula, row) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('row', `"use strict"; return (${formula})`);
    const result = fn(row);
    if (result !== null && result !== undefined && typeof result === 'object' && 'value' in result) {
      return result.value !== null && result.value !== undefined ? String(result.value) : '';
    }
    return result !== null && result !== undefined ? String(result) : '';
  } catch {
    return '';
  }
}

/**
 * @param {object[]} products
 * @param {(object|string)[]} columns  - column definitions (objects with key/label/type/formula)
 * @param {string} [filename]
 * @param {object} [options]
 * @param {Map<string,{qty:number,amount:number}>} [options.salesMap]  - keyed by SKU
 */
export function exportToExcel(
  products, 
  columns,
  filename = 'shopify-products',
  { salesMap = new Map() } = {}
) {
  // Normalize columns: handle both ColumnDefinition objects and string arrays
  const normalizedColumns = columns.map((col) => {
    if (typeof col === 'object' && col !== null) {
      const key = col.key || col.fieldPath || col.accessorKey;
      if (!key) {
        console.warn('[exportToExcel] Column object missing key:', col);
        return null;
      }
      return { ...col, key, label: col.label || key, type: col.type || 'string' };
    }
    if (typeof col === 'string') {
      return {
        key: col,
        label: col.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim(),
        type: 'string',
      };
    }
    console.warn('[exportToExcel] Invalid column type:', typeof col, col);
    return null;
  }).filter(Boolean);

  if (normalizedColumns.length === 0) {
    console.error('[exportToExcel] No valid columns after normalization. Original columns:', columns);
    throw new Error('No valid columns selected for export');
  }

  // Build export data using only the selected columns
  const exportData = products.map((product) => {
    const row = {};

    normalizedColumns.forEach((col) => {
      // --- Sales columns (not stored in Shopify, computed from salesMap) ---
      if (col.type === 'sales_qty' || col.type === 'sales_amount') {
        const sku = product.sku || product.variantSku;
        const entry = sku ? salesMap.get(sku) : null;
        if (col.type === 'sales_qty') {
          row[col.label] = entry ? entry.qty : 0;
        } else {
          row[col.label] = entry ? entry.amount : 0;
        }
        return;
      }

      // --- User-defined custom columns (formula-based) ---
      if (col.type === 'custom' && col.formula) {
        row[col.label] = evaluateCustomFormula(col.formula, product);
        return;
      }

      // --- Regular Shopify fields ---
      const value = getNestedValue(product, col.key);
      if (col.type === 'currency') {
        const numValue = typeof value === 'string' ? parseFloat(value) : Number(value);
        row[col.label] = isNaN(numValue) ? 'N/A' : numValue;
      } else if (col.type === 'date') {
        try {
          row[col.label] = new Date(value).toISOString().split('T')[0];
        } catch {
          row[col.label] = value ?? 'N/A';
        }
      } else if (col.key === 'images' || col.type === 'image') {
        // Export the image URL instead of the raw edges object
        row[col.label] = product.images?.edges?.[0]?.node?.url
          || (typeof value === 'string' ? value : 'N/A');
      } else if (value === null || value === undefined) {
        row[col.label] = 'N/A';
      } else {
        row[col.label] = value;
      }
    });

    return row;
  });
  
  
  const worksheet = XLSX.utils.json_to_sheet(exportData);
  const workbook = XLSX.utils.book_new();
  
  // Set column widths based on column count
  worksheet['!cols'] = normalizedColumns.map(() => ({ wch: 20 }));
  
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
  
  const dateStr = new Date().toISOString().split('T')[0];
  const fullFilename = `${filename}-${dateStr}.xlsx`;
  
  try {
    // Debug: log export inputs
    console.log('[exportToExcel] exporting', { fullFilename, columns: normalizedColumns.map(c=>c.key), sample: exportData[0] });

    // Try browser-friendly writeFile first
    if (typeof XLSX.writeFile === 'function') {
      XLSX.writeFile(workbook, fullFilename, { 
        bookType: 'xlsx',
        type: 'binary'
      });
      return;
    }

    // Fallback: generate array buffer and download via blob
    const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fullFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return;

  } catch (error) {
    console.error('Error writing Excel file:', error);
    const err = new Error('Failed to download Excel file: ' + (error?.message || String(error)));
    err.cause = error;
    throw err;
  }
}
