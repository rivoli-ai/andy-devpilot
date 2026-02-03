import { Component, Input, Output, EventEmitter, signal, computed, TemplateRef, ContentChild, QueryList, ViewChildren, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

export interface GridColumn {
  field: string;
  header: string;
  width?: string;
  sortable?: boolean;
  filterable?: boolean;
  groupable?: boolean;
  cellRenderer?: (value: any, row: any) => string;
  cellTemplate?: TemplateRef<any>;
  headerTemplate?: TemplateRef<any>;
  pinned?: 'left' | 'right';
  resizable?: boolean;
  comparator?: (valueA: any, valueB: any) => number;
}

export interface GridGroup {
  field: string;
  displayName?: string;
}

export type SortDirection = 'asc' | 'desc' | null;

export interface GridSort {
  field: string;
  direction: SortDirection;
}

@Component({
  selector: 'app-data-grid',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './data-grid.component.html',
  styleUrl: './data-grid.component.css'
})
export class DataGridComponent<T = any> implements OnInit {
  @Input() columns: GridColumn[] = [];
  @Input() data: T[] = [];
  @Input() enableFiltering = true;
  @Input() enableSorting = true;
  @Input() enableGrouping = true;
  @Input() enableColumnResize = true;
  @Input() enablePagination = true;
  @Input() pageSize = 10;
  @Input() pageSizeOptions = [10, 25, 50, 100];
  @Input() rowHeight = 40;
  @Input() headerHeight = 50;
  @Input() groupHeaderHeight = 35;
  @Input() showGroupCounts = true;
  @Input() emptyMessage = 'No data available';
  @Input() height?: string; // Optional height (e.g., '500px', '100%', 'calc(100vh - 200px)')
  
  @Output() rowClick = new EventEmitter<T>();
  @Output() rowDoubleClick = new EventEmitter<T>();
  @Output() sortChange = new EventEmitter<GridSort[]>();
  @Output() filterChange = new EventEmitter<Record<string, string>>();

  // State
  private _sortState = signal<Map<string, SortDirection>>(new Map());
  private _filterState = signal<Record<string, string>>({});
  private _groupState = signal<GridGroup[]>([]);
  private _expandedGroups = signal<Set<string>>(new Set());
  private _columnWidths = signal<Map<string, number>>(new Map());
  private _resizingColumn = signal<string | null>(null);
  private _resizeStartX = signal<number>(0);
  private _resizeStartWidth = signal<number>(0);
  
  // Pagination state
  currentPage = signal<number>(1);
  _pageSize = signal<number>(10);

  constructor(private sanitizer: DomSanitizer) {}
  
  ngOnInit(): void {
    this._pageSize.set(this.pageSize);
  }

  // Sanitize HTML to allow SVGs
  sanitizeHtml(html: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }

  // Computed
  sortState = computed(() => this._sortState());
  filterState = computed(() => this._filterState());
  groupState = computed(() => this._groupState());
  expandedGroups = computed(() => this._expandedGroups());

  // Filtered, sorted, and grouped data
  processedData = computed(() => {
    let result = [...this.data];

    // Apply filters
    const filters = this._filterState();
    if (Object.keys(filters).length > 0) {
      result = result.filter(row => {
        return Object.entries(filters).every(([field, filterValue]) => {
          if (!filterValue) return true;
          const column = this.columns.find(c => c.field === field);
          const cellValue = this.getCellValue(row, field);
          const searchValue = filterValue.toLowerCase();
          
          if (column?.cellRenderer) {
            const rendered = column.cellRenderer(cellValue, row);
            return rendered.toLowerCase().includes(searchValue);
          }
          
          const stringValue = cellValue?.toString().toLowerCase() || '';
          return stringValue.includes(searchValue);
        });
      });
    }

    // Apply sorting
    const sorts = Array.from(this._sortState().entries())
      .filter(([_, direction]) => direction !== null)
      .map(([field, direction]) => ({ field, direction: direction as 'asc' | 'desc' }));

    if (sorts.length > 0) {
      result.sort((a, b) => {
        for (const sort of sorts) {
          const column = this.columns.find(c => c.field === sort.field);
          let comparison = 0;

          if (column?.comparator) {
            comparison = column.comparator(
              this.getCellValue(a, sort.field),
              this.getCellValue(b, sort.field)
            );
          } else {
            const aVal = this.getCellValue(a, sort.field);
            const bVal = this.getCellValue(b, sort.field);
            
            if (aVal === bVal) continue;
            if (aVal == null) return 1;
            if (bVal == null) return -1;
            
            if (typeof aVal === 'number' && typeof bVal === 'number') {
              comparison = aVal - bVal;
            } else {
              comparison = String(aVal).localeCompare(String(bVal));
            }
          }

          if (comparison !== 0) {
            return sort.direction === 'asc' ? comparison : -comparison;
          }
        }
        return 0;
      });
    }

    // Apply grouping
    const groups = this._groupState();
    if (groups.length > 0) {
      return this.groupData(result, groups);
    }

    return result;
  });

  // Get display data (flatten groups if needed)
  displayData = computed(() => {
    const processed = this.processedData();
    const expanded = this._expandedGroups();
    
    interface DisplayItem {
      row: any;
      index: number;
      isGroup: boolean;
      groupKey?: string;
      groupValue?: any;
      groupField?: string;
      count?: number;
      level?: number;
      parentGroups?: Array<{ groupKey: string; groupValue: any; groupField: string; count: number; level: number }>;
    }
    
    if (this._groupState().length === 0) {
      return processed.map((row, index) => ({ row, index, isGroup: false, level: 0 } as DisplayItem));
    }

    const result: DisplayItem[] = [];
    
    // Recursive function to flatten nested groups
    const flattenGroups = (items: any[], level: number = 0, parentGroups: Array<{ groupKey: string; groupValue: any; groupField: string; count: number; level: number }> = []) => {
      for (const item of items) {
        if (item.groupKey) {
          // This is a group header
          const groupKey = item.groupKey;
          const groupInfo = {
            groupKey,
            groupValue: item.groupValue,
            groupField: item.groupField,
            count: item.count,
            level
          };
          
          result.push({
            row: null,
            index: result.length,
            isGroup: true,
            ...groupInfo,
            parentGroups: [...parentGroups]
          });
          
          // Process children if expanded
          if (expanded.has(groupKey) && item.rows) {
            // Check if children are also groups or actual data rows
            const hasNestedGroups = item.rows.length > 0 && item.rows[0].groupKey;
            if (hasNestedGroups) {
              // Recursively flatten nested groups with this group as parent
              flattenGroups(item.rows, level + 1, [...parentGroups, groupInfo]);
            } else {
              // These are actual data rows
              for (const dataRow of item.rows) {
                result.push({
                  row: dataRow,
                  index: result.length,
                  isGroup: false,
                  level: level + 1,
                  parentGroups: [...parentGroups, groupInfo]
                });
              }
            }
          }
        } else {
          // Regular data row (shouldn't happen at top level when grouped)
          result.push({
            row: item,
            index: result.length,
            isGroup: false,
            level,
            parentGroups
          });
        }
      }
    };
    
    flattenGroups(processed);
    
    return result;
  });

  // Pagination computed properties
  totalFilteredItems = computed(() => {
    // Count all visible items in displayData (groups + expanded rows)
    return this.displayData().length;
  });

  totalPages = computed(() => {
    if (!this.enablePagination) return 1;
    return Math.ceil(this.totalFilteredItems() / this._pageSize()) || 1;
  });

  paginatedDisplayData = computed(() => {
    if (!this.enablePagination) {
      return this.displayData();
    }
    
    const allData = this.displayData();
    const start = (this.currentPage() - 1) * this._pageSize();
    const end = start + this._pageSize();
    const pageSlice = allData.slice(start, end);
    
    // If not grouped, just return the slice
    if (this._groupState().length === 0) {
      return pageSlice;
    }
    
    // For grouped data, ensure group headers are present for all rows on this page
    const result: typeof pageSlice = [];
    const includedGroupKeys = new Set<string>();
    
    // First pass: collect all group keys that are in the slice
    for (const item of pageSlice) {
      if (item.isGroup && item.groupKey) {
        includedGroupKeys.add(item.groupKey);
      }
    }
    
    // Second pass: build result with missing parent groups
    for (const item of pageSlice) {
      // If this is a data row or nested group, ensure parent groups are included
      if (item.parentGroups && item.parentGroups.length > 0) {
        for (const parent of item.parentGroups) {
          if (!includedGroupKeys.has(parent.groupKey)) {
            // Add the missing parent group header
            result.push({
              row: null,
              index: -1, // Special index for injected headers
              isGroup: true,
              groupKey: parent.groupKey,
              groupValue: parent.groupValue,
              groupField: parent.groupField,
              count: parent.count,
              level: parent.level,
              parentGroups: []
            });
            includedGroupKeys.add(parent.groupKey);
          }
        }
      }
      result.push(item);
    }
    
    return result;
  });

  paginationInfo = computed(() => {
    const total = this.totalFilteredItems();
    const pageSize = this._pageSize();
    const page = this.currentPage();
    const start = Math.min((page - 1) * pageSize + 1, total);
    const end = Math.min(page * pageSize, total);
    return { start, end, total };
  });

  // Column widths with resizing
  columnWidths = computed(() => {
    const widths = new Map<string, number>();
    const customWidths = this._columnWidths();
    
    for (const column of this.columns) {
      if (customWidths.has(column.field)) {
        widths.set(column.field, customWidths.get(column.field)!);
      } else if (column.width) {
        const widthValue = parseInt(column.width);
        widths.set(column.field, isNaN(widthValue) ? 150 : widthValue);
      } else {
        widths.set(column.field, 150);
      }
    }
    
    return widths;
  });

  // Methods
  getCellValue(row: T, field: string): any {
    const parts = field.split('.');
    let value: any = row;
    for (const part of parts) {
      value = value?.[part];
    }
    return value;
  }

  toggleSort(field: string): void {
    if (!this.enableSorting) return;
    
    const current = this._sortState();
    const newState = new Map(current);
    const currentDirection = newState.get(field);
    
    if (currentDirection === null || currentDirection === undefined) {
      newState.set(field, 'asc');
    } else if (currentDirection === 'asc') {
      newState.set(field, 'desc');
    } else {
      newState.delete(field);
    }
    
    this._sortState.set(newState);
    
    // Emit sort change
    const sorts: GridSort[] = Array.from(newState.entries())
      .filter(([_, dir]) => dir !== null)
      .map(([f, dir]) => ({ field: f, direction: dir as SortDirection }));
    this.sortChange.emit(sorts);
  }

  getSortDirection(field: string): SortDirection {
    return this._sortState().get(field) || null;
  }

  setFilter(field: string, value: string): void {
    if (!this.enableFiltering) return;
    
    const current = this._filterState();
    const newState = { ...current };
    
    if (value) {
      newState[field] = value;
    } else {
      delete newState[field];
    }
    
    this._filterState.set(newState);
    this.filterChange.emit(newState);
    this.currentPage.set(1); // Reset to first page when filter changes
  }

  getFilter(field: string): string {
    return this._filterState()[field] || '';
  }

  toggleGroup(field: string): void {
    if (!this.enableGrouping) return;
    
    const current = this._groupState();
    const newGroups = current.filter(g => g.field !== field);
    
    if (newGroups.length === current.length) {
      // Add group
      newGroups.push({ field, displayName: this.getColumnHeader(field) });
    }
    
    this._groupState.set(newGroups);
    this._expandedGroups.set(new Set()); // Reset expanded groups
    this.currentPage.set(1); // Reset to first page when grouping changes
  }

  isGrouped(field: string): boolean {
    return this._groupState().some(g => g.field === field);
  }

  toggleGroupExpansion(groupKey: string): void {
    const current = new Set(this._expandedGroups());
    if (current.has(groupKey)) {
      current.delete(groupKey);
    } else {
      current.add(groupKey);
    }
    this._expandedGroups.set(current);
    // Reset to page 1 when expanding/collapsing as total items changes
    this.currentPage.set(1);
  }

  isGroupExpanded(groupKey: string): boolean {
    return this._expandedGroups().has(groupKey);
  }

  private groupData(data: T[], groups: GridGroup[]): any[] {
    if (groups.length === 0) return data;
    
    const group = groups[0];
    const grouped = new Map<any, T[]>();
    
    for (const row of data) {
      const value = this.getCellValue(row, group.field);
      const key = value?.toString() || 'null';
      
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(row);
    }
    
    const result: any[] = [];
    for (const [key, rows] of Array.from(grouped.entries()).sort()) {
      result.push({
        groupKey: `${group.field}:${key}`,
        groupValue: key,
        groupField: group.field,
        count: rows.length,
        rows: groups.length > 1 ? this.groupData(rows, groups.slice(1)) : rows
      });
    }
    
    return result;
  }

  getColumnHeader(field: string): string {
    const column = this.columns.find(c => c.field === field);
    return column?.header || field;
  }

  // Column resizing
  startResize(column: GridColumn, event: MouseEvent): void {
    if (!this.enableColumnResize || !column.resizable) return;
    
    event.preventDefault();
    event.stopPropagation();
    
    const width = this.columnWidths().get(column.field) || 150;
    this._resizingColumn.set(column.field);
    this._resizeStartX.set(event.clientX);
    this._resizeStartWidth.set(width);
    
    document.addEventListener('mousemove', this.handleResize);
    document.addEventListener('mouseup', this.stopResize);
  }

  private handleResize = (event: MouseEvent): void => {
    const column = this._resizingColumn();
    if (!column) return;
    
    const delta = event.clientX - this._resizeStartX();
    const newWidth = Math.max(50, this._resizeStartWidth() + delta);
    
    const current = new Map(this._columnWidths());
    current.set(column, newWidth);
    this._columnWidths.set(current);
  };

  private stopResize = (): void => {
    this._resizingColumn.set(null);
    document.removeEventListener('mousemove', this.handleResize);
    document.removeEventListener('mouseup', this.stopResize);
  };

  isResizing(column: string): boolean {
    return this._resizingColumn() === column;
  }

  // Row events
  onRowClick(row: T): void {
    this.rowClick.emit(row);
  }

  onRowDoubleClick(row: T): void {
    this.rowDoubleClick.emit(row);
  }

  onCellClick(event: MouseEvent): void {
    // Only stop propagation if clicking on an action button/link
    const target = event.target as HTMLElement;
    const actionBtn = target.closest('[data-action]');
    
    if (actionBtn) {
      // Let the action button handle the click, don't trigger row click
      event.stopPropagation();
    }
    // Otherwise, let the event bubble to trigger row click
  }

  // Clear all filters
  clearFilters(): void {
    this._filterState.set({});
    this.filterChange.emit({});
  }

  // Clear all sorts
  clearSorts(): void {
    this._sortState.set(new Map());
    this.sortChange.emit([]);
  }

  // Clear all groups
  clearGroups(): void {
    this._groupState.set([]);
    this._expandedGroups.set(new Set());
  }

  // Helper for template
  hasActiveFilters(): boolean {
    return Object.keys(this._filterState()).length > 0;
  }

  // Pagination methods
  goToPage(page: number): void {
    const total = this.totalPages();
    if (page >= 1 && page <= total) {
      this.currentPage.set(page);
    }
  }

  nextPage(): void {
    if (this.currentPage() < this.totalPages()) {
      this.currentPage.update(p => p + 1);
    }
  }

  previousPage(): void {
    if (this.currentPage() > 1) {
      this.currentPage.update(p => p - 1);
    }
  }

  firstPage(): void {
    this.currentPage.set(1);
  }

  lastPage(): void {
    this.currentPage.set(this.totalPages());
  }

  setPageSize(size: number): void {
    this._pageSize.set(size);
    this.currentPage.set(1); // Reset to first page
  }

  getPageNumbers(): number[] {
    const total = this.totalPages();
    const current = this.currentPage();
    const pages: number[] = [];
    
    if (total <= 7) {
      for (let i = 1; i <= total; i++) pages.push(i);
    } else {
      pages.push(1);
      if (current > 3) pages.push(-1); // ellipsis
      
      const start = Math.max(2, current - 1);
      const end = Math.min(total - 1, current + 1);
      
      for (let i = start; i <= end; i++) pages.push(i);
      
      if (current < total - 2) pages.push(-1); // ellipsis
      pages.push(total);
    }
    
    return pages;
  }
}
