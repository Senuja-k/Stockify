import { useState, useEffect } from 'react';
import { Plus, X, Check } from 'lucide-react';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Input } from '../ui/input';
import {
	OPERATOR_LABELS,
	NO_VALUE_OPERATORS,
	TWO_VALUE_OPERATORS,
	LIST_OPERATORS,
	STRING_OPERATORS,
	NUMBER_OPERATORS,
	DATE_OPERATORS
} from '@/lib/filterTypes';

/**
 * FilterBuilder – builds a list of conditions with AND/OR operators.
 *
 * Changes are held in an internal draft state until the user clicks
 * "Apply Filters".  This avoids triggering a server round-trip on
 * every keystroke.
 *
 *  - `onApply(filterConfig)` – called when the user clicks "Apply Filters"
 *  - `config` – the currently-applied filter config (used to initialise draft)
 */
function FilterBuilder({ config, onApply, availableColumns }) {
	// Draft state – modifications happen here until Apply
	const [draft, setDraft] = useState(() => config || { items: [] });

	// Keep draft in sync when parent resets config externally
	useEffect(() => {
		setDraft(config || { items: [] });
	}, [config]);

	const generateId = () => Math.random().toString(36).substring(2, 11);
	const items = draft.items || [];
	const getConditions = () => items.filter((item) => typeof item === 'object' && 'id' in item);

	const updateDraft = (newItems) => setDraft({ items: newItems });

	const addCondition = () => {
		const firstColumn = availableColumns[0];
		const newCondition = {
			id: generateId(),
			field: firstColumn?.key || 'title',
			operator: 'contains',
			value: ''
		};
		const newItems = [...items];
		if (newItems.length > 0) newItems.push('AND');
		newItems.push(newCondition);
		updateDraft(newItems);
	};
	const removeCondition = (itemIndex) => {
		const newItems = items.filter((_, idx) => idx !== itemIndex);
		const cleaned = [];
		for (let i = 0; i < newItems.length; i++) {
			const item = newItems[i];
			if (typeof item === 'string' && (item === 'AND' || item === 'OR')) {
				if (i === newItems.length - 1) continue;
				if (i + 1 < newItems.length) {
					const nextItem = newItems[i + 1];
					if (typeof nextItem === 'string') continue;
				}
			}
			cleaned.push(item);
		}
		updateDraft(cleaned);
	};
	const updateCondition = (itemIndex, updates) => {
		const newItems = items.map((item, idx) =>
			idx === itemIndex && typeof item === 'object' && 'id' in item
				? { ...item, ...updates }
				: item
		);
		updateDraft(newItems);
	};
	const updateOperator = (operatorIndex, newOperator) => {
		const newItems = [...items];
		newItems[operatorIndex] = newOperator;
		updateDraft(newItems);
	};
	const getOperatorsForField = (fieldKey) => {
		const column = availableColumns.find(col => col.key === fieldKey);
		if (!column) return STRING_OPERATORS;
		switch (column.type) {
			case 'number':
			case 'currency':
				return NUMBER_OPERATORS;
			case 'date':
				return DATE_OPERATORS;
			default:
				return STRING_OPERATORS;
		}
	};

	const handleApply = () => {
		onApply?.(draft);
	};

	const handleClear = () => {
		const empty = { items: [] };
		setDraft(empty);
		onApply?.(empty);
	};

	// Check whether draft differs from the currently-applied config
	const isDirty = JSON.stringify(draft) !== JSON.stringify(config);

	const conditions = getConditions();
	if (conditions.length === 0) {
		return (
			<div className="space-y-3">
				<p className="text-sm text-muted-foreground">No filters added yet</p>
				<Button onClick={addCondition} size="sm" className="gap-2">
					<Plus className="h-4 w-4" />
					Add Filter
				</Button>
			</div>
		);
	}
	return (
		<div className="space-y-3">
			{items.map((item, itemIndex) => {
				if (typeof item === 'object' && 'id' in item) {
					const condition = item;
					const needsValue = !NO_VALUE_OPERATORS.includes(condition.operator);
					const needsTwoValues = TWO_VALUE_OPERATORS.includes(condition.operator);
					const needsList = LIST_OPERATORS.includes(condition.operator);
					return (
						<div key={condition.id} className="space-y-2">
							<ConditionRow
								condition={condition}
								availableColumns={availableColumns}
								availableOperators={getOperatorsForField(condition.field)}
								needsValue={needsValue}
								needsTwoValues={needsTwoValues}
								needsList={needsList}
								onUpdate={(updates) => updateCondition(itemIndex, updates)}
								onRemove={() => removeCondition(itemIndex)}
							/>
							{itemIndex < items.length - 1 && items[itemIndex + 1] &&
							 typeof items[itemIndex + 1] === 'string' && (
								<div className="flex items-center gap-2 pl-4">
									<Select
										value={items[itemIndex + 1]}
										onValueChange={(value) => updateOperator(itemIndex + 1, value)}
									>
										<SelectTrigger className="w-24">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="AND">AND</SelectItem>
											<SelectItem value="OR">OR</SelectItem>
										</SelectContent>
									</Select>
								</div>
							)}
						</div>
					);
				}
				return null;
			})}
			{/* Action row: Add filter + Apply + Clear */}
			<div className="flex flex-wrap items-center gap-2 pt-2 border-t">
				<Button onClick={addCondition} variant="outline" size="sm" className="gap-2">
					<Plus className="h-4 w-4" />
					Add Filter
				</Button>

				<div className="ml-auto flex items-center gap-2">
					<Button onClick={handleClear} variant="ghost" size="sm" className="gap-1 text-muted-foreground">
						<X className="h-4 w-4" />
						Clear All
					</Button>
					<Button
						onClick={handleApply}
						size="sm"
						className="gap-1"
						disabled={!isDirty}
					>
						<Check className="h-4 w-4" />
						Apply Filters
					</Button>
				</div>
			</div>
		</div>
	);
}

function ConditionRow({
	condition,
	availableColumns,
	availableOperators,
	needsValue,
	needsTwoValues,
	needsList,
	onUpdate,
	onRemove
}) {
    const col = availableColumns.find(c => c.key === condition.field);
    const isNumeric = col?.type === 'number' || col?.type === 'currency';

    return (
		<div className="flex items-center gap-2 flex-wrap">
			<Select
				value={condition.field}
				onValueChange={(field) => {
					const col = availableColumns.find(c => c.key === field);
					let ops;
					switch (col?.type) {
						case 'number': case 'currency': ops = NUMBER_OPERATORS; break;
						case 'date': ops = DATE_OPERATORS; break;
						default: ops = STRING_OPERATORS;
					}
					const operator = ops.includes(condition.operator)
						? condition.operator
						: ops[0];
					onUpdate({ field, operator });
				}}
			>
				<SelectTrigger className="w-[200px]">
					<SelectValue placeholder="Select column..." />
				</SelectTrigger>
				<SelectContent>
					{/* If the stored field key is not (yet) in availableColumns, show it as a
					    disabled placeholder so the row never appears completely blank */}
					{condition.field && !availableColumns.find(c => c.key === condition.field) && (
						<SelectItem value={condition.field} disabled className="text-muted-foreground italic">
							{condition.field}
						</SelectItem>
					)}
					{availableColumns.map((col) => (
						<SelectItem key={col.key} value={col.key}>
							{col.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select
				value={condition.operator}
				onValueChange={(operator) => onUpdate({ operator })}
			>
				<SelectTrigger className="w-[180px]">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{availableOperators.map((op) => (
						<SelectItem key={op} value={op}>
							{OPERATOR_LABELS[op]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{needsValue && !needsList && (
				<>
					<Input
						type={isNumeric ? 'number' : 'text'}
						value={condition.value || ''}
						onChange={(e) => onUpdate({ value: e.target.value })}
						placeholder="Value"
						className="w-[150px]"
					/>
					{needsTwoValues && (
						<Input
							type={isNumeric ? 'number' : 'text'}
							value={condition.value2 || ''}
							onChange={(e) => onUpdate({ value2: e.target.value })}
							placeholder="Value 2"
							className="w-[150px]"
						/>
					)}
				</>
			)}
			{needsList && (
				<Input
					type="text"
					value={condition.valueList?.join(', ') || ''}
					onChange={(e) =>
						onUpdate({ valueList: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })
					}
					placeholder="Value1, Value2, Value3"
					className="w-[250px]"
				/>
			)}
			<Button variant="ghost" size="sm" onClick={onRemove}>
				<X className="h-4 w-4" />
			</Button>
		</div>
	);
}

export default FilterBuilder;
