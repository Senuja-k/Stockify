/**
 * Filter evaluation engine
 * Evaluates data rows against flat filter configurations
 */

import { getNestedValue } from './columnDetection';

/**
 * Evaluate a single condition against a data row
 */
export function evaluateCondition(row, condition) {
  const fieldValue = getNestedValue(row, condition.field);
  const { operator, value, value2, valueList } = condition;

  // Handle blank/not blank checks
  if (operator === 'is_blank') {
    return fieldValue === undefined || fieldValue === null || fieldValue === '';
  }
  if (operator === 'is_not_blank') {
    return fieldValue !== undefined && fieldValue !== null && fieldValue !== '';
  }

  // If field is blank and we're not checking for blank, return false.
  // Exception: negative operators (not_equals, not_contains) should MATCH
  // null/blank rows because "nothing" is indeed "not equal to" and "does not
  // contain" whatever the user typed.
  if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
    if (operator === 'not_equals' || operator === 'not_contains') return true;
    return false;
  }

  // Convert to strings for comparison (case-insensitive for text operators)
  const fieldStr = String(fieldValue).toLowerCase();
  const valueStr = value !== undefined ? String(value).toLowerCase() : '';
  const value2Str = value2 !== undefined ? String(value2).toLowerCase() : '';

  // Evaluate based on operator
  switch (operator) {
    case 'equals':
      return fieldStr === valueStr;
    
    case 'not_equals':
      return fieldStr !== valueStr;
    
    case 'contains':
      return fieldStr.includes(valueStr);
    
    case 'not_contains':
      return !fieldStr.includes(valueStr);
    
    case 'starts_with':
      return fieldStr.startsWith(valueStr);
    
    case 'ends_with':
      return fieldStr.endsWith(valueStr);
    
    case 'greater_than':
      return Number(fieldValue) > Number(value);
    
    case 'less_than':
      return Number(fieldValue) < Number(value);
    
    case 'greater_than_or_equal':
      return Number(fieldValue) >= Number(value);
    
    case 'less_than_or_equal':
      return Number(fieldValue) <= Number(value);
    
    case 'between':
      const numValue = Number(fieldValue);
      const numMin = Number(value);
      const numMax = Number(value2);
      return numValue >= numMin && numValue <= numMax;
    
    case 'in_list':
      if (!valueList || valueList.length === 0) return false;
      return valueList.some(v => String(v).toLowerCase() === fieldStr);
    
    default:
      console.warn(`Unknown operator: ${operator}`);
      return false;
  }
}

/**
 * Evaluate flat filter configuration against a data row
 * Processes conditions and operators in order: condition1 AND condition2 OR condition3 etc.
 */
export function evaluateFilters(row, config) {
  if (!config || !config.items || config.items.length === 0) {
    return true; // No filters means include everything
  }

  // Extract just the conditions for evaluation
  const conditions = [];
  const operators = [];

  for (let i = 0; i < config.items.length; i++) {
    const item = config.items[i];
    if (typeof item === 'object' && item && 'id' in item) {
      conditions.push(item);
    } else if (typeof item === 'string' && (item === 'AND' || item === 'OR')) {
      operators.push(item);
    }
  }

  if (conditions.length === 0) {
    return true;
  }

  // Evaluate first condition
  let result = evaluateCondition(row, conditions[0]);

  // Apply remaining conditions with their operators
  for (let i = 1; i < conditions.length; i++) {
    const conditionResult = evaluateCondition(row, conditions[i]);
    const operator = operators[i - 1] || 'AND'; // Default to AND if not specified

    if (operator === 'AND') {
      result = result && conditionResult;
    } else {
      result = result || conditionResult;
    }
  }

  return result;
}

/**
 * Apply filters to an array of data rows
 */
export function applyFilters(data, config) {
  if (!config || !config.items || config.items.length === 0) {
    return data;
  }

  return data.filter(row => evaluateFilters(row, config));
}
