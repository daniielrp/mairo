/* ==========================================================================
   Mairo Planning Whiteboard - Application Logic
   ========================================================================== */

// --- Global Error Diagnostics ---
window.addEventListener('error', (e) => {
    if (typeof showToast === 'function') {
        showToast(`Error: ${e.message} at ${e.filename.split('/').pop()}:${e.lineno}`);
    }
});

// --- Application State ---
let state = {
    template: 'sandbox', // program-board, roam-board, kanban-board, sandbox
    zoom: 1,
    pan: { x: 200, y: 100 }, // Center-leaning default
    elements: [],            // Custom whiteboard items: stickies, cards, text
    dependencies: [],        // Line connections: { id, fromId, toId, type }
    drawings: [],            // Brush stroke elements: { id, points, color, width }
    backlog: [],             // Unplanned/sidebar task cards
    history: [],             // Undo stack
    historyIndex: -1,
    config: {
        sprints: ['Sprint 1', 'Sprint 2', 'Sprint 3', 'Sprint 4', 'Sprint 5'],
        teams: ['Team Falcon', 'Team Phoenix', 'Team Triton']
    }
};

// --- Undo/Redo Engine ---
function pushState() {
    // Truncate future states if we performed actions after undoing
    if (state.historyIndex < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyIndex + 1);
    }
    
    // Deep clone elements, dependencies, drawings, backlog, config, template
    const stateClone = {
        template: state.template,
        elements: JSON.parse(JSON.stringify(state.elements)),
        dependencies: JSON.parse(JSON.stringify(state.dependencies)),
        drawings: JSON.parse(JSON.stringify(state.drawings)),
        backlog: JSON.parse(JSON.stringify(state.backlog)),
        config: JSON.parse(JSON.stringify(state.config))
    };
    
    state.history.push(stateClone);
    if (state.history.length > 50) {
        state.history.shift();
    }
    state.historyIndex = state.history.length - 1;
    saveToLocalStorage();
    updateUndoRedoButtons();
}

function undo() {
    if (state.historyIndex > 0) {
        state.historyIndex--;
        restoreFromHistoryIndex();
        showToast("Undo completed");
    }
}

function redo() {
    if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        restoreFromHistoryIndex();
        showToast("Redo completed");
    }
}

function restoreFromHistoryIndex() {
    const historical = state.history[state.historyIndex];
    state.template = historical.template;
    state.elements = JSON.parse(JSON.stringify(historical.elements));
    state.dependencies = JSON.parse(JSON.stringify(historical.dependencies));
    state.drawings = JSON.parse(JSON.stringify(historical.drawings));
    state.backlog = JSON.parse(JSON.stringify(historical.backlog));
    state.config = JSON.parse(JSON.stringify(historical.config));
    
    // Update config dropdown value to reflect restored state
    document.getElementById('config-template-select').value = state.template;
    
    renderWorkspace();
    renderBacklog();
    renderConfigOptions();
    saveToLocalStorage();
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    document.getElementById('btn-undo').disabled = (state.historyIndex <= 0);
    document.getElementById('btn-redo').disabled = (state.historyIndex >= state.history.length - 1);
}

// --- LocalStorage persistence ---
function saveToLocalStorage() {
    const data = {
        template: state.template,
        pan: state.pan,
        zoom: state.zoom,
        elements: state.elements,
        dependencies: state.dependencies,
        drawings: state.drawings,
        backlog: state.backlog,
        config: state.config
    };
    localStorage.setItem('mairo_board_state_v2', JSON.stringify(data));
}

function loadFromLocalStorage() {
    const dataStr = localStorage.getItem('mairo_board_state_v2');
    if (dataStr) {
        try {
            const parsed = JSON.parse(dataStr);
            state.template = parsed.template || 'sandbox';
            state.pan = parsed.pan || { x: 200, y: 100 };
            state.zoom = parsed.zoom || 1;
            state.elements = parsed.elements || [];
            state.dependencies = parsed.dependencies || [];
            state.drawings = parsed.drawings || [];
            state.backlog = parsed.backlog || [];
            state.config = parsed.config || {
                sprints: ['Sprint 1', 'Sprint 2', 'Sprint 3', 'Sprint 4', 'Sprint 5'],
                teams: ['Team Falcon', 'Team Phoenix', 'Team Triton']
            };
            
            // Sync form template selection
            document.getElementById('config-template-select').value = state.template;
        } catch (e) {
            console.error("Error parsing saved board state, starting fresh", e);
        }
    } else {
        // Build initial mock items to show off the board if completely fresh
        buildInitialDemoData();
    }
    
    // Seed initial history item
    state.history = [{
        template: state.template,
        elements: JSON.parse(JSON.stringify(state.elements)),
        dependencies: JSON.parse(JSON.stringify(state.dependencies)),
        drawings: JSON.parse(JSON.stringify(state.drawings)),
        backlog: JSON.parse(JSON.stringify(state.backlog)),
        config: JSON.parse(JSON.stringify(state.config))
    }];
    state.historyIndex = 0;
    updateUndoRedoButtons();
}

function buildInitialDemoData() {
    state.backlog = [];
    state.elements = [];
    state.dependencies = [];
}

// --- DOM Reference Cache ---
const container = document.getElementById('workspace-container');
const canvas = document.getElementById('infinite-canvas');
const svgLayer = document.getElementById('svg-layer');
const templatesContainer = document.getElementById('template-canvas-container');
const domContainer = document.getElementById('dom-canvas-container');

// --- Global UI States ---
let currentTool = 'select'; // select, sticky, card, connect, draw, text, eraser
let isDrawing = false;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let currentStroke = null;
let connectSourceId = null;
let selectedElementId = null;
let selectedDependencyId = null;
let isDrawingBox = false;
let boxStartCoords = null;
let currentBoxElement = null;

// --- Resize Observer for shapes/containers ---
let isResizingTableCell = false;
let isNativelyResizing = false;

const resizeObserver = new ResizeObserver(entries => {
    if (isResizingTableCell) return;
    let changed = false;
    for (let entry of entries) {
        const id = entry.target.dataset.id;
        const el = state.elements.find(e => e.id === id);
        if (el) {
            const newW = entry.target.clientWidth;
            const newH = entry.target.clientHeight;
            if (el.w !== newW || el.h !== newH) {
                if (el.type === 'table' && el.tableData) {
                    if (isNativelyResizing) {
                        const ratioW = newW / el.w;
                        const ratioH = newH / el.h;
                        if (el.tableData.colWidths) {
                            el.tableData.colWidths = el.tableData.colWidths.map(w => Math.max(30, Math.round(w * ratioW)));
                            el.w = el.tableData.colWidths.reduce((sum, w) => sum + w, 0);
                        }
                        if (el.tableData.rowHeights) {
                            el.tableData.rowHeights = el.tableData.rowHeights.map(h => Math.max(20, Math.round(h * ratioH)));
                            el.h = el.tableData.rowHeights.reduce((sum, h) => sum + h, 0);
                        }
                        changed = true;
                    }
                    // Ignore non-native table resizes to prevent janky layout loop updates
                } else {
                    el.w = newW;
                    el.h = newH;
                    changed = true;
                }
            }
        }
    }
    if (changed) {
        renderDependencies();
        saveToLocalStorage();
    }
});

// --- Canvas Navigation (Pan & Zoom Math) ---
function updateCanvasTransform() {
    canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
    document.getElementById('zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
}

function handlePanStart(clientX, clientY) {
    isPanning = true;
    panStart = { x: clientX - state.pan.x, y: clientY - state.pan.y };
    container.style.cursor = 'grabbing';
}

function handlePanMove(clientX, clientY) {
    if (!isPanning) return;
    state.pan.x = clientX - panStart.x;
    state.pan.y = clientY - panStart.y;
    updateCanvasTransform();
    updateContextToolbar();
}

function handlePanEnd() {
    if (isPanning) {
        isPanning = false;
        container.style.cursor = currentTool === 'select' ? 'default' : 'crosshair';
        saveToLocalStorage();
    }
}

function handleZoom(delta, clientX, clientY) {
    const rect = container.getBoundingClientRect();
    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;
    
    // Calculate current mouse position in canvas coordinates
    const canvasX = (mouseX - state.pan.x) / state.zoom;
    const canvasY = (mouseY - state.pan.y) / state.zoom;
    
    // Zoom factor scaling
    const scaleFactor = 1.1;
    let nextZoom = state.zoom;
    if (delta < 0) {
        nextZoom = Math.max(0.1, state.zoom / scaleFactor);
    } else {
        nextZoom = Math.min(3.0, state.zoom * scaleFactor);
    }
    
    if (nextZoom === state.zoom) return;
    
    state.zoom = nextZoom;
    // Calculate new panning offset to keep cursor locked in same space coordinate
    state.pan.x = mouseX - canvasX * state.zoom;
    state.pan.y = mouseY - canvasY * state.zoom;
    
    updateCanvasTransform();
    updateContextToolbar();
    saveToLocalStorage();
}

// Convert absolute mouse client coordinates to Canvas Coordinate Space
function clientToCanvasCoords(clientX, clientY) {
    const canvasRect = canvas.getBoundingClientRect();
    return {
        x: (clientX - canvasRect.left) / state.zoom,
        y: (clientY - canvasRect.top) / state.zoom
    };
}

// --- Main Template Grid Definitions ---
const templates = {
    'program-board': {
        left: 100,
        top: 150,
        teamColW: 200,
        sprintColW: 260,
        headerH: 60,
        milestoneH: 100,
        rowH: 180,
        getCellBounds(row, col) {
            // row: 0 is Milestone row, >=1 are Teams rows.
            // col: >=0 are Sprints
            const l = this.left + this.teamColW + col * this.sprintColW;
            const t = this.top + this.headerH + (row === 0 ? 0 : this.milestoneH + (row - 1) * this.rowH);
            const w = this.sprintColW;
            const h = row === 0 ? this.milestoneH : this.rowH;
            return { x: l, y: t, w, h };
        }
    },
    'roam-board': {
        left: 200,
        top: 150,
        quadW: 450,
        quadH: 350,
        headerH: 60,
        getCellBounds(row, col) {
            // row: 0-1, col: 0-1
            const l = this.left + col * this.quadW;
            const t = this.top + this.headerH + row * this.quadH;
            return { x: l, y: t, w: this.quadW, h: this.quadH };
        }
    },
    'kanban-board': {
        left: 200,
        top: 150,
        colW: 300,
        gap: 20,
        headerH: 50,
        colH: 600,
        getCellBounds(col) {
            const l = this.left + col * (this.colW + this.gap);
            const t = this.top + this.headerH;
            return { x: l, y: t, w: this.colW, h: this.colH };
        }
    }
};

// Snaps layout element to templates grid cells if appropriate
function snapToTemplateGrid(element, x, y) {
    const cx = x + element.w / 2;
    const cy = y + element.h / 2;
    
    if (state.template === 'program-board') {
        const tb = templates['program-board'];
        const colsCount = state.config.sprints.length;
        const rowsCount = state.config.teams.length + 1; // Includes milestones row 0
        
        // Loop and see if coordinates fall into cells
        for (let r = 0; r < rowsCount; r++) {
            for (let c = 0; c < colsCount; c++) {
                const bounds = tb.getCellBounds(r, c);
                if (cx >= bounds.x && cx <= bounds.x + bounds.w &&
                    cy >= bounds.y && cy <= bounds.y + bounds.h) {
                    
                    // Snap center nicely in cell
                    return {
                        x: bounds.x + (bounds.w - element.w) / 2,
                        y: bounds.y + (bounds.h - element.h) / 2,
                        cellData: r === 0 ? { type: 'milestone', sprint: state.config.sprints[c] } : { type: 'team', sprint: state.config.sprints[c], team: state.config.teams[r-1] }
                    };
                }
            }
        }
    } else if (state.template === 'roam-board') {
        const rb = templates['roam-board'];
        const quadNames = [
            ['Resolved', 'Owned'],
            ['Accepted', 'Mitigated']
        ];
        for (let r = 0; r < 2; r++) {
            for (let c = 0; c < 2; c++) {
                const bounds = rb.getCellBounds(r, c);
                if (cx >= bounds.x && cx <= bounds.x + bounds.w &&
                    cy >= bounds.y && cy <= bounds.y + bounds.h) {
                    return {
                        x: bounds.x + 25 + Math.random() * (bounds.w - element.w - 50), // scatter slightly so they don't overlay
                        y: bounds.y + 40 + Math.random() * (bounds.h - element.h - 80),
                        cellData: { type: 'roam', category: quadNames[r][c] }
                    };
                }
            }
        }
    } else if (state.template === 'kanban-board') {
        const kb = templates['kanban-board'];
        const cols = ['Backlog', 'To Do', 'In Progress', 'Dev/Test', 'Done'];
        for (let c = 0; c < cols.length; c++) {
            const bounds = kb.getCellBounds(c);
            if (cx >= bounds.x && cx <= bounds.x + bounds.w &&
                cy >= bounds.y && cy <= bounds.y + bounds.h) {
                return {
                    x: bounds.x + (bounds.w - element.w) / 2,
                    y: bounds.y + 20 + Math.random() * 30, // Stack from top down
                    cellData: { type: 'kanban', status: cols[c].toLowerCase() }
                };
            }
        }
    }
    return null; // No snapping match, place freely
}

// --- Render Engine ---

function renderWorkspace() {
    renderTemplate();
    renderElements();
    renderDependencies();
    renderDrawings();
    updateContextToolbar();
}

function renderTemplate() {
    templatesContainer.innerHTML = '';
    
    if (state.template === 'sandbox') return;
    
    if (state.template === 'program-board') {
        const tb = templates['program-board'];
        const cols = state.config.sprints;
        const teamsList = state.config.teams;
        
        const gridW = tb.teamColW + (cols.length * tb.sprintColW);
        const gridH = tb.headerH + tb.milestoneH + (teamsList.length * tb.rowH);
        
        const gridDiv = document.createElement('div');
        gridDiv.className = 'program-board-grid';
        gridDiv.style.gridTemplateColumns = `${tb.teamColW}px repeat(${cols.length}, ${tb.sprintColW}px)`;
        gridDiv.style.width = `${gridW + 20}px`;
        gridDiv.style.height = `${gridH + 20}px`;
        gridDiv.style.left = `${tb.left}px`;
        gridDiv.style.top = `${tb.top}px`;
        
        // 1. Header Cells (Top Row)
        const cornerHeader = document.createElement('div');
        cornerHeader.className = 'pb-header';
        cornerHeader.innerHTML = `<strong>Teams \\ Iterations</strong>`;
        gridDiv.appendChild(cornerHeader);
        
        cols.forEach((sprint, cIdx) => {
            const header = document.createElement('div');
            header.className = 'pb-header';
            header.innerHTML = `<input type="text" data-sprint-idx="${cIdx}" value="${sprint}">`;
            gridDiv.appendChild(header);
        });
        
        // 2. Milestones Row
        const msTitle = document.createElement('div');
        msTitle.className = 'pb-milestone-title pb-milestone-row';
        msTitle.innerHTML = `<span>Objectives & Milestones</span>`;
        gridDiv.appendChild(msTitle);
        
        cols.forEach(() => {
            const cell = document.createElement('div');
            cell.className = 'pb-cell pb-milestone-row';
            gridDiv.appendChild(cell);
        });
        
        // 3. Team Rows
        teamsList.forEach((team, rIdx) => {
            const teamRow = document.createElement('div');
            teamRow.className = 'pb-team-row';
            teamRow.innerHTML = `<input type="text" data-team-idx="${rIdx}" value="${team}">`;
            gridDiv.appendChild(teamRow);
            
            cols.forEach(() => {
                const cell = document.createElement('div');
                cell.className = 'pb-cell';
                gridDiv.appendChild(cell);
            });
        });
        
        templatesContainer.appendChild(gridDiv);
        setupTemplateHeaderListeners();
    }
    
    else if (state.template === 'roam-board') {
        const rb = templates['roam-board'];
        const gridDiv = document.createElement('div');
        gridDiv.className = 'roam-board-grid';
        gridDiv.style.left = `${rb.left}px`;
        gridDiv.style.top = `${rb.top}px`;
        
        const titleRow = document.createElement('div');
        titleRow.className = 'roam-title';
        titleRow.textContent = 'ROAM Program Risk Assessment';
        gridDiv.appendChild(titleRow);
        
        const quads = [
            { class: 'r', title: '✓ Resolved', desc: 'Risks that are no longer a threat; addressed and closed.' },
            { class: 'o', title: '👤 Owned', desc: 'Risks assigned to an owner who will monitor and manage them.' },
            { class: 'a', title: '🤝 Accepted', desc: 'Risks that cannot be resolved; acknowledged and tolerated.' },
            { class: 'm', title: '🛡️ Mitigated', desc: 'Risks with actions put in place to reduce impact or probability.' }
        ];
        
        quads.forEach(q => {
            const quad = document.createElement('div');
            quad.className = `roam-quadrant ${q.class}`;
            quad.innerHTML = `
                <h3>${q.title}</h3>
                <p>${q.desc}</p>
            `;
            gridDiv.appendChild(quad);
        });
        
        templatesContainer.appendChild(gridDiv);
    }
    
    else if (state.template === 'kanban-board') {
        const kb = templates['kanban-board'];
        const gridDiv = document.createElement('div');
        gridDiv.className = 'kanban-board-grid';
        gridDiv.style.left = `${kb.left}px`;
        gridDiv.style.top = `${kb.top}px`;
        gridDiv.style.minHeight = `${kb.colH}px`;
        
        const columns = [
            { name: 'Backlog', count: 0 },
            { name: 'To Do', count: 0 },
            { name: 'In Progress', count: 0 },
            { name: 'Dev/Test', count: 0 },
            { name: 'Done', count: 0 }
        ];
        
        // Count elements per category
        state.elements.forEach(el => {
            if (el.type === 'card' && el.cardData && el.cardData.status) {
                const stat = el.cardData.status;
                if (stat === 'backlog') columns[0].count++;
                else if (stat === 'todo') columns[1].count++;
                else if (stat === 'doing') columns[2].count++;
                else if (stat === 'blocked') columns[3].count++;
                else if (stat === 'done') columns[4].count++;
            }
        });
        
        columns.forEach(col => {
            const colDiv = document.createElement('div');
            colDiv.className = 'kanban-col';
            colDiv.style.width = `${kb.colW}px`;
            colDiv.innerHTML = `
                <h3>
                    <span>${col.name}</span>
                    <span class="kanban-col-count">${col.count}</span>
                </h3>
            `;
            gridDiv.appendChild(colDiv);
        });
        
        templatesContainer.appendChild(gridDiv);
    }
}

// Allows custom team/sprint editing in Program board headers
function setupTemplateHeaderListeners() {
    const sprintInputs = templatesContainer.querySelectorAll('input[data-sprint-idx]');
    sprintInputs.forEach(input => {
        input.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.sprintIdx);
            state.config.sprints[idx] = e.target.value;
            pushState();
        });
    });
    
    const teamInputs = templatesContainer.querySelectorAll('input[data-team-idx]');
    teamInputs.forEach(input => {
        input.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.teamIdx);
            state.config.teams[idx] = e.target.value;
            pushState();
        });
    });
}

function renderElements() {
    domContainer.innerHTML = '';
    
    state.elements.forEach(el => {
        const wrapper = document.createElement('div');
        const isSelected = el.id === selectedElementId;
        wrapper.className = `board-element type-${el.type} ${isSelected ? 'selected' : ''} ${el.id === connectSourceId ? 'link-source' : ''}`;
        wrapper.style.left = `${el.x}px`;
        wrapper.style.top = `${el.y}px`;
        wrapper.style.width = `${el.w}px`;
        wrapper.style.height = `${el.h}px`;
        wrapper.dataset.id = el.id;
        
        // Selection is now handled natively via mousedown inside setupElementDragEvents to support instant selection-focus.
        
        // Render internal template depending on type
        if (el.type === 'sticky') {
            const sticky = document.createElement('div');
            sticky.className = `sticky-note color-${el.color || 'yellow'}`;
            
            const textarea = document.createElement('textarea');
            textarea.className = 'sticky-text';
            textarea.value = el.content || '';
            textarea.placeholder = 'Type something...';
            textarea.readOnly = true; // Readonly by default to allow wrapper click selection
            
            if (el.fontSize) {
                textarea.style.fontSize = `${el.fontSize}px`;
            }
            
            textarea.addEventListener('blur', () => {
                textarea.readOnly = true;
            });
            
            textarea.addEventListener('change', (e) => {
                el.content = e.target.value;
                pushState();
            });
            sticky.appendChild(textarea);
            wrapper.appendChild(sticky);
        }
        
        else if (el.type === 'card') {
            const card = document.createElement('div');
            const data = el.cardData || {};
            card.className = `task-card cat-${el.color || 'story'} card-status-${data.status || 'todo'}`;
            
            // Avatar fallback initials
            const init = (data.owner || 'U').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
            
            card.innerHTML = `
                <div class="card-header">
                    <span class="card-key">${data.key || 'TASK'}</span>
                    <span class="card-badge">${el.color || 'Story'}</span>
                </div>
                <div class="card-title">${data.title || 'Untitled Card'}</div>
                <div class="card-footer">
                    <div class="card-points">${data.points || 'SP'}</div>
                    <div class="card-status-indicator">
                        <span class="status-indicator-dot"></span>
                        <span style="font-size:10px; opacity:0.8; text-transform:capitalize;">${data.status || 'todo'}</span>
                    </div>
                    <div class="card-owner">
                        <div class="card-owner-avatar" title="${data.owner || 'Unassigned'}">${init}</div>
                    </div>
                </div>
            `;
            wrapper.appendChild(card);
            
            // Double click to edit card detail modal
            wrapper.addEventListener('dblclick', () => {
                openEditModal(el.id);
            });
        }
        
        else if (el.type === 'box') {
            wrapper.classList.add('resizable');
            resizeObserver.observe(wrapper);
            
            const box = document.createElement('div');
            box.className = 'whiteboard-box';
            if (el.color) {
                box.style.borderColor = getBoxColorHex(el.color);
            }
            wrapper.appendChild(box);
        }
        
        else if (el.type === 'text') {
            const label = document.createElement('div');
            label.className = 'text-label';
            
            const input = document.createElement('input');
            input.type = 'text';
            input.value = el.content || 'Double-click to text';
            input.readOnly = true; // Readonly by default to allow selection
            
            input.style.color = getTextColorHex(el.color);
            if (el.fontSize) {
                input.style.fontSize = `${el.fontSize}px`;
            }
            
            input.addEventListener('blur', () => {
                input.readOnly = true;
            });
            
            input.addEventListener('change', (e) => {
                el.content = e.target.value;
                pushState();
            });
            label.appendChild(input);
            wrapper.appendChild(label);
        }
        
        else if (el.type === 'table') {
            wrapper.classList.add('resizable');
            resizeObserver.observe(wrapper);
            
            const tableCont = document.createElement('div');
            tableCont.className = 'whiteboard-table-container';
            if (el.color) {
                tableCont.style.borderColor = getBoxColorHex(el.color);
            }
            
            const table = document.createElement('table');
            table.className = 'whiteboard-table';
            table.style.tableLayout = 'fixed';
            
            const data = el.tableData || {
                headers: ['Col 1', 'Col 2', 'Col 3'],
                rows: [
                    ['', '', ''],
                    ['', '', '']
                ]
            };
            if (!el.tableData) {
                el.tableData = data;
            }
            
            let colWidths = data.colWidths;
            if (!colWidths || colWidths.length !== data.headers.length) {
                colWidths = [];
                let remW = el.w;
                const count = data.headers.length;
                for (let i = 0; i < count - 1; i++) {
                    const w = Math.round(el.w / count);
                    colWidths.push(w);
                    remW -= w;
                }
                colWidths.push(remW);
                data.colWidths = colWidths;
            }
            
            let rowHeights = data.rowHeights;
            if (!rowHeights || rowHeights.length !== data.rows.length + 1) {
                rowHeights = [];
                let remH = el.h;
                const count = data.rows.length + 1;
                for (let i = 0; i < count - 1; i++) {
                    const h = Math.round(el.h / count);
                    rowHeights.push(h);
                    remH -= h;
                }
                rowHeights.push(remH);
                data.rowHeights = rowHeights;
            }
            
            // Build colgroup
            const colGroup = document.createElement('colgroup');
            colWidths.forEach((w, cIdx) => {
                const col = document.createElement('col');
                col.style.width = `${w}px`;
                colGroup.appendChild(col);
            });
            table.appendChild(colGroup);
            
            // Helper function to attach column resizing
            const makeColResizable = (handleEl, cIdx) => {
                handleEl.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    isResizingTableCell = true;
                    const startX = e.clientX;
                    const startWidth = colWidths[cIdx];
                    const cols = colGroup.querySelectorAll('col');
                    
                    const onMouseMove = (moveEvent) => {
                        const dx = (moveEvent.clientX - startX) / state.zoom;
                        const newWidth = Math.max(30, startWidth + dx);
                        colWidths[cIdx] = newWidth;
                        
                        const totalW = colWidths.reduce((sum, w) => sum + w, 0);
                        el.w = totalW;
                        wrapper.style.width = `${totalW}px`;
                        if (cols[cIdx]) {
                            cols[cIdx].style.width = `${newWidth}px`;
                        }
                        renderDependencies();
                    };
                    
                    const onMouseUp = () => {
                        document.removeEventListener('mousemove', onMouseMove);
                        document.removeEventListener('mouseup', onMouseUp);
                        isResizingTableCell = false;
                        pushState();
                        renderWorkspace();
                    };
                    
                    document.addEventListener('mousemove', onMouseMove);
                    document.addEventListener('mouseup', onMouseUp);
                });
            };
            
            // Helper function to attach row resizing
            const makeRowResizable = (handleEl, rIdx) => {
                handleEl.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    isResizingTableCell = true;
                    const startY = e.clientY;
                    const startHeight = rowHeights[rIdx];
                    
                    const onMouseMove = (moveEvent) => {
                        const dy = (moveEvent.clientY - startY) / state.zoom;
                        const newHeight = Math.max(20, startHeight + dy);
                        rowHeights[rIdx] = newHeight;
                        
                        const totalH = rowHeights.reduce((sum, h) => sum + h, 0);
                        el.h = totalH;
                        wrapper.style.height = `${totalH}px`;
                        
                        // Update specific row height in DOM
                        const trs = table.querySelectorAll('tr');
                        if (trs[rIdx]) {
                            trs[rIdx].style.height = `${newHeight}px`;
                        }
                        renderDependencies();
                    };
                    
                    const onMouseUp = () => {
                        document.removeEventListener('mousemove', onMouseMove);
                        document.removeEventListener('mouseup', onMouseUp);
                        isResizingTableCell = false;
                        pushState();
                        renderWorkspace();
                    };
                    
                    document.addEventListener('mousemove', onMouseMove);
                    document.addEventListener('mouseup', onMouseUp);
                });
            };
            
            const tHead = document.createElement('thead');
            const headerRow = document.createElement('tr');
            headerRow.style.height = `${rowHeights[0]}px`;
            
            data.headers.forEach((hVal, cIdx) => {
                const th = document.createElement('th');
                const input = document.createElement('input');
                input.value = hVal;
                input.readOnly = true;
                
                input.addEventListener('blur', () => {
                    input.readOnly = true;
                });
                
                input.addEventListener('change', (e) => {
                    data.headers[cIdx] = e.target.value;
                    pushState();
                });
                
                th.appendChild(input);
                
                // Add column resize handle
                const colHandle = document.createElement('div');
                colHandle.className = 'table-col-resize-handle';
                makeColResizable(colHandle, cIdx);
                th.appendChild(colHandle);
                
                // Add row resize handle
                const rowHandle = document.createElement('div');
                rowHandle.className = 'table-row-resize-handle';
                makeRowResizable(rowHandle, 0);
                th.appendChild(rowHandle);
                
                headerRow.appendChild(th);
            });
            tHead.appendChild(headerRow);
            table.appendChild(tHead);
            
            const tBody = document.createElement('tbody');
            data.rows.forEach((row, rIdx) => {
                const tr = document.createElement('tr');
                tr.style.height = `${rowHeights[rIdx + 1]}px`;
                
                row.forEach((cellVal, cIdx) => {
                    const td = document.createElement('td');
                    const input = document.createElement('input');
                    input.value = cellVal;
                    input.readOnly = true;
                    
                    input.addEventListener('blur', () => {
                        input.readOnly = true;
                    });
                    
                    input.addEventListener('change', (e) => {
                        data.rows[rIdx][cIdx] = e.target.value;
                        pushState();
                    });
                    
                    td.appendChild(input);
                    
                    // Add column resize handle
                    const colHandle = document.createElement('div');
                    colHandle.className = 'table-col-resize-handle';
                    makeColResizable(colHandle, cIdx);
                    td.appendChild(colHandle);
                    
                    // Add row resize handle
                    const rowHandle = document.createElement('div');
                    rowHandle.className = 'table-row-resize-handle';
                    makeRowResizable(rowHandle, rIdx + 1);
                    td.appendChild(rowHandle);
                    
                    tr.appendChild(td);
                });
                tBody.appendChild(tr);
            });
            table.appendChild(tBody);
            tableCont.appendChild(table);
            wrapper.appendChild(tableCont);
        }
        // Append connection handles to the wrapper for drag-to-connect interactions
        const positions = ['top', 'right', 'bottom', 'left'];
        positions.forEach(pos => {
            const handle = document.createElement('div');
            handle.className = `connection-handle handle-${pos}`;
            handle.dataset.position = pos;
            
            handle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                startConnectionDrag(e, el.id, pos);
            });
            
            wrapper.appendChild(handle);
        });
        
        setupElementDragEvents(wrapper, el);
        domContainer.appendChild(wrapper);
    });
}

function renderDependencies() {
    // Clear dynamic connections, delete buttons, and groups from SVGs
    svgLayer.querySelectorAll('.dependency-line, .dep-delete-btn, .dep-delete-bg, .dependency-group').forEach(n => n.remove());
    
    state.dependencies.forEach(dep => {
        const fromEl = state.elements.find(el => el.id === dep.fromId);
        const toEl = state.elements.find(el => el.id === dep.toId);
        
        if (!fromEl || !toEl) return; // Clean up orphaned links
        
        // Calculate connection points
        const fromPoints = getElementConnectionPoints(fromEl);
        const fromPos = dep.fromPos || 'right';
        const fromPt = fromPoints[fromPos];
        
        const toPoints = getElementConnectionPoints(toEl);
        
        // Find closest target point
        let toPt = toPoints.left; // default
        let minDist = Infinity;
        Object.values(toPoints).forEach(pt => {
            const dist = Math.hypot(pt.x - fromPt.x, pt.y - fromPt.y);
            if (dist < minDist) {
                minDist = dist;
                toPt = pt;
            }
        });
        
        const x1 = fromPt.x;
        const y1 = fromPt.y;
        const x2 = toPt.x;
        const y2 = toPt.y;
        
        // Control point calculations for elegant S-curves
        const dx = Math.abs(x2 - x1);
        const dy = Math.abs(y2 - y1);
        
        let cp1x = x1;
        let cp1y = y1;
        if (fromPos === 'left') {
            cp1x -= dx * 0.4;
        } else if (fromPos === 'right') {
            cp1x += dx * 0.4;
        } else if (fromPos === 'top') {
            cp1y -= dy * 0.4;
        } else if (fromPos === 'bottom') {
            cp1y += dy * 0.4;
        }
        
        let cp2x = x2;
        let cp2y = y2;
        if (toPt.name === 'left') {
            cp2x -= dx * 0.4;
        } else if (toPt.name === 'right') {
            cp2x += dx * 0.4;
        } else if (toPt.name === 'top') {
            cp2y -= dy * 0.4;
        } else if (toPt.name === 'bottom') {
            cp2y += dy * 0.4;
        }
        
        const d = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
        
        // Create SVG Group
        const depGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        depGroup.setAttribute('class', 'dependency-group');
        
        // Draw a thick transparent background path for easy hovering
        const hoverPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hoverPath.setAttribute('d', d);
        hoverPath.setAttribute('fill', 'none');
        hoverPath.setAttribute('stroke', 'transparent');
        hoverPath.setAttribute('stroke-width', '16');
        hoverPath.setAttribute('style', 'pointer-events: stroke; cursor: pointer;');
        depGroup.appendChild(hoverPath);
        
        // Draw the path
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', `dependency-line status-${dep.type || 'critical'}`);
        
        // Highlight if selected
        const isSelected = dep.id === selectedDependencyId;
        if (isSelected) {
            path.classList.add('selected');
        }
        
        // Apply custom color if set
        let strokeColor = '#ef4444'; // default red
        if (dep.color) {
            strokeColor = getDependencyColorHex(dep.color);
        } else if (dep.type === 'healthy') {
            strokeColor = '#10b981';
        } else if (dep.type === 'blocked') {
            strokeColor = '#f59e0b';
        }
        path.style.stroke = strokeColor;
        
        // Apply custom line thickness
        path.setAttribute('stroke-width', dep.strokeWidth || 3);
        
        // Apply custom line style (dasharray)
        if (dep.lineStyle === 'dashed') {
            path.setAttribute('stroke-dasharray', '8,6');
        } else if (dep.lineStyle === 'dotted') {
            path.setAttribute('stroke-dasharray', '2,4');
        } else {
            path.removeAttribute('stroke-dasharray');
        }
        
        // Use matching marker end
        if (dep.type === 'critical') {
            path.setAttribute('marker-end', 'url(#arrow-critical)');
        } else {
            path.setAttribute('marker-end', 'url(#arrow)');
        }
        
        path.dataset.depId = dep.id;
        depGroup.appendChild(path);
        
        // Add mousedown selection listener to hoverPath and path
        const handleSelectDep = (e) => {
            e.stopPropagation();
            selectedDependencyId = dep.id;
            selectedElementId = null; // Clear active element selection
            
            // Remove active classes in DOM immediately
            domContainer.querySelectorAll('.board-element').forEach(el => el.classList.remove('selected'));
            
            // Trigger dependency highlight and toolbar position updates
            renderDependencies();
            updateContextToolbar();
        };
        hoverPath.addEventListener('mousedown', handleSelectDep);
        path.addEventListener('mousedown', handleSelectDep);
        
        svgLayer.appendChild(depGroup);
    });
}

function renderDrawings() {
    // Clear drawn paths and straight lines
    svgLayer.querySelectorAll('.drawing-stroke, .drawing-line').forEach(n => n.remove());
    
    state.drawings.forEach(stroke => {
        if (stroke.points.length < 2) return;
        
        // Construct SVG path data
        let d = `M ${stroke.points[0].x} ${stroke.points[0].y}`;
        if (stroke.isLine) {
            d += ` L ${stroke.points[1].x} ${stroke.points[1].y}`;
        } else {
            for (let i = 1; i < stroke.points.length; i++) {
                d += ` L ${stroke.points[i].x} ${stroke.points[i].y}`;
            }
        }
        
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('stroke', stroke.color || '#6366f1');
        path.setAttribute('stroke-width', stroke.width || 4);
        path.setAttribute('fill', 'none');
        path.setAttribute('class', stroke.isLine ? 'drawing-line' : 'drawing-stroke');
        
        // Eraser tool clicks directly on paths to delete
        path.addEventListener('click', (e) => {
            if (currentTool === 'eraser') {
                e.stopPropagation();
                deleteDrawing(stroke.id);
            }
        });
        
        svgLayer.appendChild(path);
    });
}

// --- Sidebar Backlog list builder ---
function renderBacklog() {
    const list = document.getElementById('backlog-items');
    list.innerHTML = '';
    
    if (state.backlog.length === 0) {
        list.innerHTML = '<div class="empty-state">No backlog cards. Click "Create Card" to start building your backlog.</div>';
        return;
    }
    
    state.backlog.forEach(item => {
        const cardItem = document.createElement('div');
        cardItem.className = `backlog-card-item ${item.type || 'story'}`;
        cardItem.setAttribute('draggable', 'true');
        cardItem.dataset.id = item.id;
        
        cardItem.innerHTML = `
            <div class="item-title">${item.title || 'Untitled Card'}</div>
            <div class="item-meta">
                <span>${item.key || 'TASK'}</span>
                <span>Points: ${item.points || 'SP'}</span>
            </div>
        `;
        
        // HTML5 dragstart listener
        cardItem.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', item.id);
            cardItem.style.opacity = '0.4';
        });
        
        cardItem.addEventListener('dragend', () => {
            cardItem.style.opacity = '1';
        });
        
        list.appendChild(cardItem);
    });
}

// --- Board Elements Management Actions ---

function addSticky(x, y) {
    const id = 'sticky-' + Date.now();
    state.elements.push({
        id,
        type: 'sticky',
        x: x || 300,
        y: y || 200,
        w: 150,
        h: 150,
        content: '',
        color: 'yellow'
    });
    pushState();
    renderElements();
}

function addTaskCard(x, y, initialData = null) {
    const id = 'card-' + Date.now();
    const data = initialData || {
        key: 'KEY-' + Math.floor(Math.random() * 900 + 100),
        title: 'New planning card',
        desc: '',
        points: '3',
        owner: 'Assignee',
        status: 'todo',
        team: ''
    };
    
    const element = {
        id,
        type: 'card',
        x: x || 400,
        y: y || 250,
        w: 220,
        h: 125,
        color: initialData ? initialData.type : 'story',
        cardData: data
    };
    
    // Check if drops onto a cell and needs alignment
    const snap = snapToTemplateGrid(element, element.x, element.y);
    if (snap) {
        element.x = snap.x;
        element.y = snap.y;
        if (snap.cellData) {
            if (snap.cellData.type === 'team') {
                element.cardData.team = snap.cellData.team;
                element.cardData.status = 'todo';
            } else if (snap.cellData.type === 'roam') {
                element.color = 'risk';
                element.cardData.status = 'todo';
            }
        }
    }
    
    state.elements.push(element);
    pushState();
    renderElements();
}

function addTable(x, y) {
    const id = 'table-' + Date.now();
    const w = 400;
    const h = 180;
    state.elements.push({
        id,
        type: 'table',
        x: x || 300,
        y: y || 200,
        w: w,
        h: h,
        color: 'blue',
        tableData: {
            headers: ['Header 1', 'Header 2', 'Header 3'],
            rows: [
                ['', '', ''],
                ['', '', '']
            ],
            colWidths: [133, 133, 134],
            rowHeights: [60, 60, 60]
        }
    });
    pushState();
    renderElements();
}

function addTableRow() {
    if (!selectedElementId) return;
    const el = state.elements.find(e => e.id === selectedElementId);
    if (!el || el.type !== 'table') return;
    
    const colsCount = el.tableData.headers.length;
    const newRow = Array(colsCount).fill('');
    el.tableData.rows.push(newRow);
    
    // Initialize heights if not present
    if (!el.tableData.rowHeights) {
        el.tableData.rowHeights = Array(el.tableData.rows.length).fill(Math.round(el.h / el.tableData.rows.length));
    }
    // Append default height (36) for new row
    el.tableData.rowHeights.push(36);
    
    // Sum to update el.h
    el.h = el.tableData.rowHeights.reduce((sum, val) => sum + val, 0);
    
    pushState();
    renderWorkspace();
}

function deleteTableRow() {
    if (!selectedElementId) return;
    const el = state.elements.find(e => e.id === selectedElementId);
    if (!el || el.type !== 'table') return;
    
    if (el.tableData.rows.length > 1) {
        el.tableData.rows.pop();
        if (el.tableData.rowHeights && el.tableData.rowHeights.length > 2) {
            el.tableData.rowHeights.pop();
        } else {
            el.tableData.rowHeights = Array(el.tableData.rows.length + 1).fill(Math.round(el.h / (el.tableData.rows.length + 1)));
        }
        
        // Sum to update el.h
        el.h = el.tableData.rowHeights.reduce((sum, val) => sum + val, 0);
        pushState();
        renderWorkspace();
    } else {
        showToast("Table must have at least 1 data row!");
    }
}

function addTableColumn() {
    if (!selectedElementId) return;
    const el = state.elements.find(e => e.id === selectedElementId);
    if (!el || el.type !== 'table') return;
    
    const nextColNum = el.tableData.headers.length + 1;
    el.tableData.headers.push(`Header ${nextColNum}`);
    
    el.tableData.rows.forEach(row => {
        row.push('');
    });
    
    // Initialize widths if not present
    if (!el.tableData.colWidths) {
        el.tableData.colWidths = Array(el.tableData.headers.length - 1).fill(Math.round(el.w / (el.tableData.headers.length - 1)));
    }
    el.tableData.colWidths.push(100);
    
    // Sum to update el.w
    el.w = el.tableData.colWidths.reduce((sum, val) => sum + val, 0);
    
    pushState();
    renderWorkspace();
}

function deleteTableColumn() {
    if (!selectedElementId) return;
    const el = state.elements.find(e => e.id === selectedElementId);
    if (!el || el.type !== 'table') return;
    
    if (el.tableData.headers.length > 1) {
        el.tableData.headers.pop();
        el.tableData.rows.forEach(row => {
            row.pop();
        });
        if (el.tableData.colWidths && el.tableData.colWidths.length > 1) {
            el.tableData.colWidths.pop();
        } else {
            el.tableData.colWidths = Array(el.tableData.headers.length).fill(Math.round(el.w / el.tableData.headers.length));
        }
        
        // Sum to update el.w
        el.w = el.tableData.colWidths.reduce((sum, val) => sum + val, 0);
        pushState();
        renderWorkspace();
    } else {
        showToast("Table must have at least 1 column!");
    }
}

function addBox(x, y) {
    const id = 'box-' + Date.now();
    state.elements.push({
        id,
        type: 'box',
        x: x || 300,
        y: y || 200,
        w: 350,
        h: 220,
        content: 'Group Container Box'
    });
    pushState();
    renderElements();
}

function addTextLabel(x, y) {
    const id = 'text-' + Date.now();
    state.elements.push({
        id,
        type: 'text',
        x: x || 300,
        y: y || 200,
        w: 250,
        h: 36,
        content: 'New Text Header'
    });
    pushState();
    renderElements();
}

function deleteElement(id) {
    // Delete target element
    state.elements = state.elements.filter(el => el.id !== id);
    
    // Check if we deleted the selected dependency's endpoints
    const wasDependencyOrphaned = selectedDependencyId && !state.dependencies.some(dep => dep.id === selectedDependencyId && dep.fromId !== id && dep.toId !== id);
    
    // Clean up connections pointing to or from this element
    state.dependencies = state.dependencies.filter(dep => dep.fromId !== id && dep.toId !== id);
    
    if (selectedElementId === id) {
        selectedElementId = null;
    }
    if (wasDependencyOrphaned) {
        selectedDependencyId = null;
    }
    
    pushState();
    renderWorkspace();
}

function deleteDependency(id) {
    state.dependencies = state.dependencies.filter(dep => dep.id !== id);
    if (selectedDependencyId === id) {
        selectedDependencyId = null;
    }
    pushState();
    renderWorkspace();
}

function deleteDrawing(id) {
    state.drawings = state.drawings.filter(stroke => stroke.id !== id);
    pushState();
    renderDrawings();
}

// --- Floating Contextual Toolbar Operations ---

function getDependencyColorHex(color) {
    const map = {
        yellow: '#f59e0b',
        pink: '#ec4899',
        green: '#10b981',
        blue: '#3b82f6',
        purple: '#8b5cf6',
        orange: '#f97316',
        black: document.body.classList.contains('dark-theme') ? '#ffffff' : '#0f172a'
    };
    return map[color] || '#ef4444';
}

function getBoxColorHex(color) {
    const map = {
        yellow: '#eab308',
        pink: '#db2777',
        green: '#16a34a',
        blue: '#2563eb',
        purple: '#9333ea',
        orange: '#ea580c',
        black: document.body.classList.contains('dark-theme') ? '#ffffff' : '#000000'
    };
    return map[color] || (document.body.classList.contains('dark-theme') ? '#ffffff' : '#000000');
}

function getTextColorHex(color) {
    const map = {
        yellow: '#d97706', // dark amber for readability
        pink: '#db2777',
        green: '#16a34a',
        blue: '#2563eb',
        purple: '#9333ea',
        orange: '#ea580c',
        black: 'var(--text-primary)'
    };
    return map[color] || 'var(--text-primary)';
}

// --- Drag-to-Connect Core Interactions ---

function getElementConnectionPoints(el) {
    return {
        top: { x: el.x + el.w / 2, y: el.y, name: 'top' },
        right: { x: el.x + el.w, y: el.y + el.h / 2, name: 'right' },
        bottom: { x: el.x + el.w / 2, y: el.y + el.h, name: 'bottom' },
        left: { x: el.x, y: el.y + el.h / 2, name: 'left' }
    };
}

let isDraggingConnection = false;
let connectionDragSourceId = null;
let connectionDragSourcePos = null;
let connectionDragStartPoint = null;

function startConnectionDrag(e, fromId, fromPos) {
    const el = state.elements.find(item => item.id === fromId);
    if (!el) return;
    
    isDraggingConnection = true;
    connectionDragSourceId = fromId;
    connectionDragSourcePos = fromPos;
    
    // Calculate starting position of handle in canvas coordinates
    const points = getElementConnectionPoints(el);
    const startPt = points[fromPos];
    connectionDragStartPoint = { x: startPt.x, y: startPt.y };
    
    document.addEventListener('mousemove', onConnectionDragMove);
    document.addEventListener('mouseup', onConnectionDragUp);
}

function onConnectionDragMove(e) {
    if (!isDraggingConnection) return;
    
    const coords = clientToCanvasCoords(e.clientX, e.clientY);
    
    // Calculate bezier curve
    const x1 = connectionDragStartPoint.x;
    const y1 = connectionDragStartPoint.y;
    const x2 = coords.x;
    const y2 = coords.y;
    
    const dx = Math.abs(x2 - x1);
    let cp1x = x1, cp1y = y1, cp2x = x2, cp2y = y2;
    
    if (connectionDragSourcePos === 'left') {
        cp1x -= dx * 0.4;
    } else if (connectionDragSourcePos === 'right') {
        cp1x += dx * 0.4;
    } else if (connectionDragSourcePos === 'top') {
        cp1y -= Math.abs(y2 - y1) * 0.4;
    } else if (connectionDragSourcePos === 'bottom') {
        cp1y += Math.abs(y2 - y1) * 0.4;
    }
    
    const d = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
    
    // Update or create temp SVG path
    let tempLine = svgLayer.querySelector('#temp-connection-line');
    if (!tempLine) {
        tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempLine.setAttribute('id', 'temp-connection-line');
        tempLine.setAttribute('stroke', '#6366f1');
        tempLine.setAttribute('stroke-dasharray', '5,5');
        tempLine.setAttribute('stroke-width', '2.5');
        tempLine.setAttribute('fill', 'none');
        svgLayer.appendChild(tempLine);
    }
    tempLine.setAttribute('d', d);
}

function onConnectionDragUp(e) {
    if (!isDraggingConnection) return;
    isDraggingConnection = false;
    
    document.removeEventListener('mousemove', onConnectionDragMove);
    document.removeEventListener('mouseup', onConnectionDragUp);
    
    // Remove temp line
    const tempLine = svgLayer.querySelector('#temp-connection-line');
    if (tempLine) tempLine.remove();
    
    // Determine what element we released on
    const targetNode = document.elementFromPoint(e.clientX, e.clientY);
    if (!targetNode) return;
    
    // Find closest board-element
    const targetWrapper = targetNode.closest('.board-element');
    if (!targetWrapper) return;
    
    const toId = targetWrapper.dataset.id;
    const fromId = connectionDragSourceId;
    
    if (toId && fromId && toId !== fromId) {
        // Create connection
        const exists = state.dependencies.some(d => d.fromId === fromId && d.toId === toId);
        if (!exists) {
            state.dependencies.push({
                id: 'dep-' + Date.now(),
                fromId: fromId,
                toId: toId,
                type: 'critical',
                fromPos: connectionDragSourcePos
            });
            pushState();
        } else {
            showToast("Connection already exists!");
        }
    }
    
    connectionDragSourceId = null;
    connectionDragSourcePos = null;
    connectionDragStartPoint = null;
    
    renderWorkspace();
}

function updateContextToolbar() {
    const toolbar = document.getElementById('context-toolbar');
    if (!toolbar) return;
    
    if (!selectedElementId && !selectedDependencyId) {
        toolbar.classList.add('hidden');
        return;
    }
    
    // Position parameters
    let targetRect = null;
    let toolbarColor = '';
    
    const fontGroup = document.getElementById('context-font-size-group');
    const dividerFont = document.getElementById('context-divider-font');
    const lineStyleGroup = document.getElementById('context-line-style-group');
    const dividerLine = document.getElementById('context-divider-line');
    const tableGroup = document.getElementById('context-table-group');
    const dividerTable = document.getElementById('context-divider-table');
    
    if (selectedElementId) {
        const selectedEl = state.elements.find(el => el.id === selectedElementId);
        const domEl = domContainer.querySelector(`[data-id="${selectedElementId}"]`);
        
        if (!selectedEl || !domEl) {
            toolbar.classList.add('hidden');
            return;
        }
        
        toolbar.classList.remove('hidden');
        toolbarColor = selectedEl.color;
        
        // Setup font size visibility
        if (selectedEl.type === 'sticky' || selectedEl.type === 'text') {
            if (fontGroup) fontGroup.style.display = 'flex';
            if (dividerFont) dividerFont.style.display = 'block';
            
            const fontSizeLabel = document.getElementById('label-font-size');
            if (fontSizeLabel) {
                fontSizeLabel.textContent = `${selectedEl.fontSize || (selectedEl.type === 'text' ? 16 : 13)}px`;
            }
        } else {
            if (fontGroup) fontGroup.style.display = 'none';
            if (dividerFont) dividerFont.style.display = 'none';
        }
        
        // Hide line style controls
        if (lineStyleGroup) lineStyleGroup.style.display = 'none';
        if (dividerLine) dividerLine.style.display = 'none';
        
        // Setup table controls visibility
        if (selectedEl.type === 'table') {
            if (tableGroup) tableGroup.style.display = 'flex';
            if (dividerTable) dividerTable.style.display = 'block';
        } else {
            if (tableGroup) tableGroup.style.display = 'none';
            if (dividerTable) dividerTable.style.display = 'none';
        }
        
        targetRect = domEl.getBoundingClientRect();
    }
    
    else if (selectedDependencyId) {
        const dep = state.dependencies.find(d => d.id === selectedDependencyId);
        if (!dep) {
            toolbar.classList.add('hidden');
            return;
        }
        
        const fromEl = state.elements.find(el => el.id === dep.fromId);
        const toEl = state.elements.find(el => el.id === dep.toId);
        
        if (!fromEl || !toEl) {
            toolbar.classList.add('hidden');
            return;
        }
        
        toolbar.classList.remove('hidden');
        toolbarColor = dep.color || 'red'; // default class is red/critical
        
        // Hide table controls
        if (tableGroup) tableGroup.style.display = 'none';
        if (dividerTable) dividerTable.style.display = 'none';
        
        // Show thickness controls (reused font controls)
        if (fontGroup) fontGroup.style.display = 'flex';
        if (dividerFont) dividerFont.style.display = 'block';
        
        const thickLabel = document.getElementById('label-font-size');
        if (thickLabel) {
            thickLabel.textContent = `${dep.strokeWidth || 3}px`;
        }
        
        // Show line style controls
        if (lineStyleGroup) lineStyleGroup.style.display = 'flex';
        if (dividerLine) dividerLine.style.display = 'block';
        
        // Set active line style button state
        const styles = ['solid', 'dashed', 'dotted'];
        styles.forEach(s => {
            const btn = document.getElementById(`btn-line-${s}`);
            const isActive = (dep.lineStyle || 'solid') === s;
            if (btn) {
                if (isActive) btn.classList.add('active');
                else btn.classList.remove('active');
            }
        });
        
        // Calculate midpoint in canvas coordinates
        const fromPoints = getElementConnectionPoints(fromEl);
        const fromPt = fromPoints[dep.fromPos || 'right'];
        const toPoints = getElementConnectionPoints(toEl);
        
        let toPt = toPoints.left;
        let minDist = Infinity;
        Object.values(toPoints).forEach(pt => {
            const dist = Math.hypot(pt.x - fromPt.x, pt.y - fromPt.y);
            if (dist < minDist) {
                minDist = dist;
                toPt = pt;
            }
        });
        
        const x1 = fromPt.x;
        const y1 = fromPt.y;
        const x2 = toPt.x;
        const y2 = toPt.y;
        
        const dx = Math.abs(x2 - x1);
        const dy = Math.abs(y2 - y1);
        
        const fromPos = dep.fromPos || 'right';
        let cp1x = x1;
        let cp1y = y1;
        if (fromPos === 'left') cp1x -= dx * 0.4;
        else if (fromPos === 'right') cp1x += dx * 0.4;
        else if (fromPos === 'top') cp1y -= dy * 0.4;
        else if (fromPos === 'bottom') cp1y += dy * 0.4;
        
        let cp2x = x2;
        let cp2y = y2;
        if (toPt.name === 'left') cp2x -= dx * 0.4;
        else if (toPt.name === 'right') cp2x += dx * 0.4;
        else if (toPt.name === 'top') cp2y -= dy * 0.4;
        else if (toPt.name === 'bottom') cp2y += dy * 0.4;
        
        const mx = 0.125 * x1 + 0.375 * cp1x + 0.375 * cp2x + 0.125 * x2;
        const my = 0.125 * y1 + 0.375 * cp1y + 0.375 * cp2y + 0.125 * y2;
        
        // Convert to screen coordinates
        const canvasRect = canvas.getBoundingClientRect();
        const screenX = canvasRect.left + mx * state.zoom;
        const screenY = canvasRect.top + my * state.zoom;
        
        targetRect = {
            left: screenX,
            right: screenX,
            top: screenY,
            bottom: screenY,
            width: 0,
            height: 0
        };
    }
    
    // Highlight the selected color dot if it exists
    const colorDots = toolbar.querySelectorAll('.color-picker-dot');
    colorDots.forEach(dot => {
        if (dot.dataset.color === toolbarColor) {
            dot.classList.add('active');
        } else {
            dot.classList.remove('active');
        }
    });
    
    const toolbarRect = toolbar.getBoundingClientRect();
    
    // Calculate position: left-aligned to target element
    const left = targetRect.left;
    const top = targetRect.top - toolbarRect.height - 12; // 12px gap
    
    // Prevent floating off-screen
    const finalLeft = Math.max(16, Math.min(window.innerWidth - toolbarRect.width - 16, left));
    const finalTop = Math.max(16, top);
    
    toolbar.style.left = `${finalLeft}px`;
    toolbar.style.top = `${finalTop}px`;
}

function changeFontSize(direction) {
    if (selectedElementId) {
        const el = state.elements.find(e => e.id === selectedElementId);
        if (!el || (el.type !== 'sticky' && el.type !== 'text')) return;
        
        const defaultSize = el.type === 'text' ? 16 : 13;
        let size = el.fontSize || defaultSize;
        
        if (direction === 'dec') {
            size = Math.max(10, size - 2);
        } else if (direction === 'inc') {
            size = Math.min(36, size + 2);
        }
        
        el.fontSize = size;
        pushState();
        
        // Update DOM directly for smooth transition
        const domEl = domContainer.querySelector(`[data-id="${selectedElementId}"]`);
        if (domEl) {
            const input = domEl.querySelector('textarea, input');
            if (input) {
                input.style.fontSize = `${size}px`;
            }
        }
        
        // Update label on toolbar
        const label = document.getElementById('label-font-size');
        if (label) label.textContent = `${size}px`;
    }
    
    else if (selectedDependencyId) {
        const dep = state.dependencies.find(d => d.id === selectedDependencyId);
        if (!dep) return;
        
        let width = dep.strokeWidth || 3;
        
        if (direction === 'dec') {
            width = Math.max(1, width - 1);
        } else if (direction === 'inc') {
            width = Math.min(10, width + 1);
        }
        
        dep.strokeWidth = width;
        pushState();
        
        // Update DOM directly for smooth transition
        renderDependencies();
        
        // Update label on toolbar
        const label = document.getElementById('label-font-size');
        if (label) label.textContent = `${width}px`;
    }
}

function changeColor(color) {
    if (selectedElementId) {
        const el = state.elements.find(e => e.id === selectedElementId);
        if (!el) return;
        
        if (el.type === 'sticky') {
            el.color = color;
            const domEl = domContainer.querySelector(`[data-id="${selectedElementId}"]`);
            if (domEl) {
                const sticky = domEl.querySelector('.sticky-note');
                if (sticky) {
                    sticky.className = `sticky-note color-${color}`;
                }
            }
        } else if (el.type === 'card') {
            let category = 'story';
            if (color === 'yellow') category = 'risk';
            else if (color === 'pink' || color === 'purple') category = 'milestone';
            else if (color === 'orange') category = 'feature';
            else if (color === 'black') category = 'dependency';
            else if (color === 'blue') category = 'story';
            else if (color === 'green') category = 'story';
            
            el.color = category;
            el.cardData.type = category;
            
            const domEl = domContainer.querySelector(`[data-id="${selectedElementId}"]`);
            if (domEl) {
                const card = domEl.querySelector('.task-card');
                if (card) {
                    card.className = `task-card cat-${category} card-status-${el.cardData.status || 'todo'}`;
                    const badge = card.querySelector('.card-badge');
                    if (badge) badge.textContent = category.toUpperCase();
                }
            }
        } else if (el.type === 'box') {
            el.color = color;
            const domEl = domContainer.querySelector(`[data-id="${selectedElementId}"]`);
            if (domEl) {
                const box = domEl.querySelector('.whiteboard-box');
                if (box) {
                    box.style.borderColor = getBoxColorHex(color);
                }
            }
        } else if (el.type === 'table') {
            el.color = color;
            const domEl = domContainer.querySelector(`[data-id="${selectedElementId}"]`);
            if (domEl) {
                const tableCont = domEl.querySelector('.whiteboard-table-container');
                if (tableCont) {
                    tableCont.style.borderColor = getBoxColorHex(color);
                }
            }
        } else if (el.type === 'text') {
            el.color = color;
            const domEl = domContainer.querySelector(`[data-id="${selectedElementId}"]`);
            if (domEl) {
                const input = domEl.querySelector('input');
                if (input) {
                    input.style.color = getTextColorHex(color);
                }
            }
        }
    }
    
    else if (selectedDependencyId) {
        const dep = state.dependencies.find(d => d.id === selectedDependencyId);
        if (!dep) return;
        
        dep.color = color;
        // Also map type for status checks
        if (color === 'yellow') dep.type = 'blocked';
        else if (color === 'green') dep.type = 'healthy';
        else dep.type = 'critical';
        
        pushState();
        renderDependencies();
    }
    
    // Update active color dot indicator
    const toolbar = document.getElementById('context-toolbar');
    if (toolbar) {
        const dots = toolbar.querySelectorAll('.color-picker-dot');
        dots.forEach(dot => {
            if (dot.dataset.color === color) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });
    }
}

function setLineStyle(style) {
    if (!selectedDependencyId) return;
    const dep = state.dependencies.find(d => d.id === selectedDependencyId);
    if (dep) {
        dep.lineStyle = style;
        pushState();
        renderDependencies();
        updateContextToolbar();
    }
}

// --- Element Dragging & Selection Engine ---
function setupElementDragEvents(domElement, dataObject) {
    let startX = 0, startY = 0;
    let originalX = 0, originalY = 0;
    let isMoving = false;
    let moved = false;
    
    domElement.addEventListener('mousedown', (e) => {
        if (currentTool !== 'select') return;
        
        // Detect native resize click in bottom-right corner (approx 20x20px area)
        const rect = domElement.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        if (clickX > rect.width - 20 && clickY > rect.height - 20 && domElement.classList.contains('resizable')) {
            isNativelyResizing = true;
            const onMouseUp = () => {
                isNativelyResizing = false;
                document.removeEventListener('mouseup', onMouseUp);
                pushState();
                renderWorkspace();
            };
            document.addEventListener('mouseup', onMouseUp);
            return; // Exit early to prevent moving/dragging the element
        }
        
        if (e.target.classList.contains('delete-element-btn') || e.target.classList.contains('color-dot') || e.target.classList.contains('color-picker-dot') || e.target.classList.contains('connection-handle')) return;
        
        const isInput = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT';
        
        // If they click inside a text field that is already focused/editable, let them type/select text naturally
        if (isInput && !e.target.readOnly) {
            return;
        }
        
        // Prevent default for shape boundaries to prevent cursor selection issues, but allow input element focusing
        if (!isInput) {
            e.preventDefault();
        }
        e.stopPropagation();
        
        // Select element immediately on click/drag
        selectedElementId = dataObject.id;
        domContainer.querySelectorAll('.board-element').forEach(el => el.classList.remove('selected'));
        domElement.classList.add('selected');
        updateContextToolbar();
        
        isMoving = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        originalX = dataObject.x;
        originalY = dataObject.y;
        
        domElement.classList.add('dragging');
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
    
    function onMouseMove(e) {
        if (!isMoving) return;
        
        const dx = (e.clientX - startX) / state.zoom;
        const dy = (e.clientY - startY) / state.zoom;
        
        // Threshold check to distinguish drags from subtle clicks
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
            moved = true;
        }
        
        dataObject.x = originalX + dx;
        dataObject.y = originalY + dy;
        
        domElement.style.left = `${dataObject.x}px`;
        domElement.style.top = `${dataObject.y}px`;
        
        renderDependencies();
        updateContextToolbar();
    }
    
    function onMouseUp(e) {
        if (!isMoving) return;
        isMoving = false;
        domElement.classList.remove('dragging');
        
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        
        // If it was a simple click (not dragged), immediately put cursor inside the text field
        if (!moved) {
            const inputEl = (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') ? e.target : domElement.querySelector('textarea, input');
            if (inputEl) {
                inputEl.readOnly = false;
                inputEl.focus();
                // Put cursor at the end of the text
                const val = inputEl.value;
                inputEl.value = '';
                inputEl.value = val;
            }
            updateContextToolbar();
            return;
        }
        
        // Snapping logic checks
        const snapResult = snapToTemplateGrid(dataObject, dataObject.x, dataObject.y);
        if (snapResult) {
            dataObject.x = snapResult.x;
            dataObject.y = snapResult.y;
            
            if (dataObject.type === 'card' && snapResult.cellData) {
                const cData = snapResult.cellData;
                if (cData.type === 'team') {
                    dataObject.cardData.team = cData.team;
                } else if (cData.type === 'kanban') {
                    dataObject.cardData.status = cData.status;
                } else if (cData.type === 'roam') {
                    dataObject.cardData.status = 'todo';
                }
            }
        }
        
        pushState();
        renderWorkspace();
    }
}


// --- Card Details Editor Modal Operations ---
function openEditModal(cardId) {
    const element = state.elements.find(el => el.id === cardId);
    if (!element || element.type !== 'card') return;
    
    const form = document.getElementById('card-edit-form');
    form.reset();
    
    const data = element.cardData || {};
    document.getElementById('edit-card-id-raw').value = element.id;
    document.getElementById('edit-card-key').value = data.key || '';
    document.getElementById('edit-card-type').value = element.color || 'story';
    document.getElementById('edit-card-title').value = data.title || '';
    document.getElementById('edit-card-desc').value = data.desc || '';
    document.getElementById('edit-card-points').value = data.points || '';
    document.getElementById('edit-card-owner').value = data.owner || '';
    document.getElementById('edit-card-status').value = data.status || 'todo';
    document.getElementById('edit-card-team').value = data.team || '';
    
    document.getElementById('edit-modal').classList.add('show');
}

function closeEditModal() {
    document.getElementById('edit-modal').classList.remove('show');
}

function saveCardDetails() {
    const id = document.getElementById('edit-card-id-raw').value;
    const element = state.elements.find(el => el.id === id);
    
    if (!element) return;
    
    const key = document.getElementById('edit-card-key').value;
    const type = document.getElementById('edit-card-type').value;
    const title = document.getElementById('edit-card-title').value;
    const desc = document.getElementById('edit-card-desc').value;
    const points = document.getElementById('edit-card-points').value;
    const owner = document.getElementById('edit-card-owner').value;
    const status = document.getElementById('edit-card-status').value;
    const team = document.getElementById('edit-card-team').value;
    
    element.color = type;
    element.cardData = {
        key,
        title,
        desc,
        points,
        owner,
        status,
        team
    };
    
    // Check if the status requires dependency lines updates
    state.dependencies.forEach(dep => {
        if (dep.fromId === id || dep.toId === id) {
            // Update line indicator styling automatically
            if (status === 'blocked') {
                dep.type = 'blocked';
            } else if (status === 'done') {
                dep.type = 'healthy';
            }
        }
    });
    
    closeEditModal();
    pushState();
    renderWorkspace();
    showToast("Card details saved");
}

// --- HTML5 Drag and Drop from Backlog Panel ---
function setupHTML5DragNDrop() {
    const dropArea = document.getElementById('workspace-container');
    
    dropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        
        // Highlight grid box under drag position
        const canvasCoords = clientToCanvasCoords(e.clientX, e.clientY);
        const tempEl = { w: 220, h: 125 };
        const snap = snapToTemplateGrid(tempEl, canvasCoords.x - 110, canvasCoords.y - 62);
        
        // Remove prior grid drop guides
        templatesContainer.querySelectorAll('.pb-cell, .roam-quadrant, .kanban-col').forEach(n => n.classList.remove('drag-over'));
        
        if (snap && state.template === 'program-board') {
            // Find matched visual index
            const tb = templates['program-board'];
            const cells = templatesContainer.querySelectorAll('.pb-cell');
            
            // Loop coordinate mapping to light up cell matching snap coords
            const colsCount = state.config.sprints.length;
            const rowsCount = state.config.teams.length + 1;
            let flatIdx = 0;
            
            for (let r = 0; r < rowsCount; r++) {
                for (let c = 0; c < colsCount; c++) {
                    const bounds = tb.getCellBounds(r, c);
                    if (Math.abs(bounds.x + (bounds.w - tempEl.w)/2 - snap.x) < 2 &&
                        Math.abs(bounds.y + (bounds.h - tempEl.h)/2 - snap.y) < 2) {
                        
                        // Account for header layout offsetting: row 0 matches Sprints 0-N cells (idx 0 to colsCount-1)
                        // Rows 1+ offset accordingly
                        const gridCells = templatesContainer.querySelectorAll('.pb-cell');
                        if (gridCells[flatIdx]) {
                            gridCells[flatIdx].classList.add('drag-over');
                        }
                        break;
                    }
                    flatIdx++;
                }
            }
        }
    });
    
    dropArea.addEventListener('dragleave', () => {
        templatesContainer.querySelectorAll('.pb-cell, .roam-quadrant, .kanban-col').forEach(n => n.classList.remove('drag-over'));
    });
    
    dropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        templatesContainer.querySelectorAll('.pb-cell, .roam-quadrant, .kanban-col').forEach(n => n.classList.remove('drag-over'));
        
        const cardId = e.dataTransfer.getData('text/plain');
        const backlogItemIdx = state.backlog.findIndex(item => item.id === cardId);
        
        if (backlogItemIdx === -1) return;
        
        const backlogItem = state.backlog[backlogItemIdx];
        
        // Calculate canvas space dropped position
        const canvasCoords = clientToCanvasCoords(e.clientX, e.clientY);
        
        // Center card coordinates
        const x = canvasCoords.x - 110;
        const y = canvasCoords.y - 62;
        
        // Construct the planning board item
        addTaskCard(x, y, {
            key: backlogItem.key,
            type: backlogItem.type,
            title: backlogItem.title,
            desc: backlogItem.desc,
            points: backlogItem.points,
            owner: backlogItem.owner,
            status: 'todo', // Convert to planned active state
            team: backlogItem.team
        });
        
        // Remove from list backlog state
        state.backlog.splice(backlogItemIdx, 1);
        pushState();
        renderBacklog();
    });
}

// --- Configuration Sidebar Operations ---
function renderConfigOptions() {
    const container = document.getElementById('template-customization-options');
    container.innerHTML = '';
    
    if (state.template === 'program-board') {
        const sprintsHTML = state.config.sprints.map((s, i) => `
            <div class="config-item-row">
                <input type="text" value="${s}" data-sprint-edit-id="${i}">
                <button class="btn-del-sprint" data-sprint-del-id="${i}">×</button>
            </div>
        `).join('');
        
        const teamsHTML = state.config.teams.map((t, i) => `
            <div class="config-item-row">
                <input type="text" value="${t}" data-team-edit-id="${i}">
                <button class="btn-del-team" data-team-del-id="${i}">×</button>
            </div>
        `).join('');
        
        container.innerHTML = `
            <div class="config-options-group">
                <h4>Iterations / Sprints</h4>
                <div class="config-list-container">${sprintsHTML}</div>
                <button class="btn-small" id="btn-config-add-sprint">+ Add Sprint</button>
            </div>
            
            <div class="config-options-group" style="margin-top:15px;">
                <h4>Scrum / Agile Teams</h4>
                <div class="config-list-container">${teamsHTML}</div>
                <button class="btn-small" id="btn-config-add-team">+ Add Team</button>
            </div>
        `;
        
        setupConfigListeners();
    }
}

function setupConfigListeners() {
    // Sprint edits
    container.querySelectorAll('input[data-sprint-edit-id]').forEach(input => {
        input.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.sprintEditId);
            state.config.sprints[idx] = e.target.value;
            pushState();
            renderWorkspace();
        });
    });
    // Team edits
    container.querySelectorAll('input[data-team-edit-id]').forEach(input => {
        input.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.teamEditId);
            state.config.teams[idx] = e.target.value;
            pushState();
            renderWorkspace();
        });
    });
    
    // Add Sprint
    const addSprint = document.getElementById('btn-config-add-sprint');
    if (addSprint) {
        addSprint.addEventListener('click', () => {
            const nextNum = state.config.sprints.length + 1;
            state.config.sprints.push(`Sprint ${nextNum}`);
            pushState();
            renderWorkspace();
            renderConfigOptions();
        });
    }
    // Add Team
    const addTeam = document.getElementById('btn-config-add-team');
    if (addTeam) {
        addTeam.addEventListener('click', () => {
            const nextNum = state.config.teams.length + 1;
            state.config.teams.push(`Team Name ${nextNum}`);
            pushState();
            renderWorkspace();
            renderConfigOptions();
        });
    }
    
    // Delete buttons
    container.querySelectorAll('.btn-del-sprint').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.target.dataset.sprintDelId);
            if (state.config.sprints.length > 1) {
                state.config.sprints.splice(idx, 1);
                pushState();
                renderWorkspace();
                renderConfigOptions();
            } else {
                showToast("Must have at least 1 Sprint column!");
            }
        });
    });
    container.querySelectorAll('.btn-del-team').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.target.dataset.teamDelId);
            if (state.config.teams.length > 1) {
                state.config.teams.splice(idx, 1);
                pushState();
                renderWorkspace();
                renderConfigOptions();
            } else {
                showToast("Must have at least 1 Team row!");
            }
        });
    });
}

// --- Import & Export Engine ---

function exportToJSON() {
    const dataStr = JSON.stringify(state, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `Mairo_PlanBoard_${state.template}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("JSON file exported");
}

function handleJSONImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            const parsed = JSON.parse(evt.target.result);
            state.template = parsed.template || 'program-board';
            state.elements = parsed.elements || [];
            state.dependencies = parsed.dependencies || [];
            state.drawings = parsed.drawings || [];
            state.backlog = parsed.backlog || [];
            state.config = parsed.config || state.config;
            
            // Focus viewport back to center coordinates
            state.pan = { x: 200, y: 100 };
            state.zoom = 1;
            updateCanvasTransform();
            
            document.getElementById('config-template-select').value = state.template;
            
            pushState();
            renderWorkspace();
            renderBacklog();
            renderConfigOptions();
            showToast("Import successful!");
        } catch (err) {
            alert("Error reading JSON file format. Make sure it is a valid Mairo board save.");
        }
    };
    reader.readAsText(file);
}

// Visual layout rendering to temporary `<canvas>` for image exports
function downloadPNGImage() {
    showToast("Compiling board image, downloading...");
    
    // Bounds scanning: Find max x, y limits of the current board structure to trim canvas dimensions
    let minX = 0, minY = 0, maxX = 1200, maxY = 800;
    
    if (state.elements.length > 0) {
        minX = Math.min(...state.elements.map(e => e.x)) - 100;
        minY = Math.min(...state.elements.map(e => e.y)) - 100;
        maxX = Math.max(...state.elements.map(e => e.x + e.w)) + 150;
        maxY = Math.max(...state.elements.map(e => e.y + e.h)) + 150;
    }
    
    // Ensure boundary constraints
    minX = Math.max(0, minX);
    minY = Math.max(0, minY);
    
    const exportW = maxX - minX;
    const exportH = maxY - minY;
    
    const expCanvas = document.createElement('canvas');
    expCanvas.width = exportW;
    expCanvas.height = exportH;
    const ctx = expCanvas.getContext('2d');
    
    // Background theme filling
    const isDark = document.body.classList.contains('dark-theme');
    ctx.fillStyle = isDark ? '#0b0f19' : '#f8fafc';
    ctx.fillRect(0, 0, exportW, exportH);
    
    // Draw simple background grid
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
    for (let x = 0; x < exportW; x += 40) {
        for (let y = 0; y < exportH; y += 40) {
            ctx.beginPath();
            ctx.arc(x, y, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    
    // Draw template structure (if active)
    if (state.template === 'program-board') {
        const tb = templates['program-board'];
        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
        ctx.fillStyle = isDark ? '#131b2e' : '#ffffff';
        ctx.lineWidth = 1;
        
        // Offset mapping to local export coordinates
        const ox = tb.left - minX;
        const oy = tb.top - minY;
        const cols = state.config.sprints;
        const teams = state.config.teams;
        
        const totalW = tb.teamColW + cols.length * tb.sprintColW;
        const totalH = tb.headerH + tb.milestoneH + teams.length * tb.rowH;
        
        // Render box
        ctx.fillRect(ox, oy, totalW, totalH);
        ctx.strokeRect(ox, oy, totalW, totalH);
        
        // Draw grid dividers
        // Verticals
        ctx.beginPath();
        let currX = ox + tb.teamColW;
        for (let i = 0; i <= cols.length; i++) {
            ctx.moveTo(currX, oy);
            ctx.lineTo(currX, oy + totalH);
            currX += tb.sprintColW;
        }
        
        // Horizontals
        ctx.moveTo(ox, oy + tb.headerH);
        ctx.lineTo(ox + totalW, oy + tb.headerH);
        ctx.moveTo(ox, oy + tb.headerH + tb.milestoneH);
        ctx.lineTo(ox + totalW, oy + tb.headerH + tb.milestoneH);
        
        let currY = oy + tb.headerH + tb.milestoneH + tb.rowH;
        for (let i = 0; i < teams.length; i++) {
            ctx.moveTo(ox, currY);
            ctx.lineTo(ox + totalW, currY);
            currY += tb.rowH;
        }
        ctx.stroke();
        
        // Render labels texts
        ctx.font = 'bold 14px Outfit, sans-serif';
        ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
        ctx.fillText("Teams \\ Iterations", ox + 20, oy + 32);
        
        cols.forEach((sprint, c) => {
            ctx.fillText(sprint, ox + tb.teamColW + c * tb.sprintColW + 20, oy + 32);
        });
        
        ctx.fillStyle = '#ff7171';
        ctx.fillText("Objectives & Milestones", ox + 20, oy + tb.headerH + 40);
        
        ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
        teams.forEach((team, r) => {
            ctx.fillText(team, ox + 20, oy + tb.headerH + tb.milestoneH + r * tb.rowH + 40);
        });
    }
    
    // Draw drawn strokes & lines
    state.drawings.forEach(stroke => {
        if (stroke.points.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = stroke.color || '#6366f1';
        ctx.lineWidth = stroke.width || 4;
        ctx.lineCap = 'round';
        
        ctx.moveTo(stroke.points[0].x - minX, stroke.points[0].y - minY);
        if (stroke.isLine) {
            ctx.lineTo(stroke.points[1].x - minX, stroke.points[1].y - minY);
        } else {
            for (let i = 1; i < stroke.points.length; i++) {
                ctx.lineTo(stroke.points[i].x - minX, stroke.points[i].y - minY);
            }
        }
        ctx.stroke();
    });
    
    // Draw SVG connections (Bezier curves)
    state.dependencies.forEach(dep => {
        const fromEl = state.elements.find(el => el.id === dep.fromId);
        const toEl = state.elements.find(el => el.id === dep.toId);
        if (!fromEl || !toEl) return;
        
        const x1 = fromEl.x + fromEl.w - minX;
        const y1 = fromEl.y + fromEl.h / 2 - minY;
        const x2 = toEl.x - minX;
        const y2 = toEl.y + toEl.h / 2 - minY;
        
        const dx = Math.abs(x2 - x1);
        const cp1x = x1 + dx * 0.4;
        const cp1y = y1;
        const cp2x = x2 - dx * 0.4;
        const cp2y = y2;
        
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
        
        if (dep.type === 'critical') ctx.strokeStyle = '#ef4444';
        else if (dep.type === 'blocked') {
            ctx.strokeStyle = '#f59e0b';
            ctx.setLineDash([5, 5]);
        } else ctx.strokeStyle = '#10b981';
        
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.setLineDash([]); // Reset
    });
    
    // Draw elements (Stickies / Cards / Text labels)
    state.elements.forEach(el => {
        const ex = el.x - minX;
        const ey = el.y - minY;
        
        if (el.type === 'sticky') {
            ctx.fillStyle = getStickyColorCode(el.color);
            ctx.fillRect(ex, ey, el.w, el.h);
            ctx.shadowBlur = 10;
            ctx.shadowColor = 'rgba(0,0,0,0.1)';
            
            // Draw content
            ctx.shadowBlur = 0; // reset
            ctx.fillStyle = '#0f172a';
            ctx.font = '12px Outfit, sans-serif';
            wrapText(ctx, el.content || '', ex + 10, ey + 24, el.w - 20, 16);
        }
        
        else if (el.type === 'card') {
            const data = el.cardData || {};
            
            // Card base
            ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
            ctx.fillRect(ex, ey, el.w, el.h);
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
            ctx.lineWidth = 1;
            ctx.strokeRect(ex, ey, el.w, el.h);
            
            // Left color strip
            ctx.fillStyle = getCategoryColorCode(el.color);
            ctx.fillRect(ex, ey, 5, el.h);
            
            // Card Header Texts
            ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
            ctx.font = 'bold 9px Courier, monospace';
            ctx.fillText(data.key || 'TASK', ex + 12, ey + 20);
            
            ctx.fillStyle = getCategoryColorCode(el.color);
            ctx.font = 'bold 8px Outfit, sans-serif';
            ctx.fillText((el.color || 'STORY').toUpperCase(), ex + el.w - 60, ey + 20);
            
            // Card title wrapping
            ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
            ctx.font = 'bold 11px Outfit, sans-serif';
            wrapText(ctx, data.title || 'Untitled Card', ex + 12, ey + 42, el.w - 24, 15);
            
            // Points bubble
            ctx.fillStyle = isDark ? '#334155' : '#f1f5f9';
            ctx.fillRect(ex + 12, ey + el.h - 26, 30, 16);
            ctx.fillStyle = isDark ? '#94a3b8' : '#475569';
            ctx.font = '9px Outfit, sans-serif';
            ctx.fillText(data.points || 'SP', ex + 18, ey + el.h - 14);
            
            // Status marker
            ctx.fillStyle = getStatusColorCode(data.status);
            ctx.beginPath();
            ctx.arc(ex + 60, ey + el.h - 18, 3, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.fillStyle = isDark ? '#94a3b8' : '#475569';
            ctx.font = '8px Outfit, sans-serif';
            ctx.fillText((data.status || 'todo').toUpperCase(), ex + 68, ey + el.h - 15);
            
            // Assignee
            ctx.fillStyle = '#6366f1';
            ctx.beginPath();
            ctx.arc(ex + el.w - 22, ey + el.h - 18, 9, 0, Math.PI*2);
            ctx.fill();
            
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 8px Outfit, sans-serif';
            const initials = (data.owner || 'U').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();
            ctx.fillText(initials, ex + el.w - 26, ey + el.h - 15);
        }
        
        else if (el.type === 'box') {
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2.5;
            ctx.strokeRect(ex, ey, el.w, el.h);
        }
        
        else if (el.type === 'table') {
            const data = el.tableData || { headers: [], rows: [] };
            const colWidths = data.colWidths || Array(data.headers.length).fill(el.w / data.headers.length);
            const rowHeights = data.rowHeights || Array(data.rows.length + 1).fill(el.h / (data.rows.length + 1));
            
            // Compute cumulative offsets
            const xOffsets = [];
            let currentX = 0;
            for (let c = 0; c < colWidths.length; c++) {
                xOffsets.push(currentX);
                currentX += colWidths[c];
            }
            
            const yOffsets = [];
            let currentY = 0;
            for (let r = 0; r < rowHeights.length; r++) {
                yOffsets.push(currentY);
                currentY += rowHeights[r];
            }
            
            // Draw table base container
            ctx.fillStyle = isDark ? '#1e293b' : '#ffffff';
            ctx.fillRect(ex, ey, el.w, el.h);
            ctx.strokeStyle = getBoxColorHex(el.color);
            ctx.lineWidth = 2;
            ctx.strokeRect(ex, ey, el.w, el.h);
            
            // Draw horizontal dividers
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
            ctx.lineWidth = 1;
            for (let r = 1; r < rowHeights.length; r++) {
                ctx.beginPath();
                ctx.moveTo(ex, ey + yOffsets[r]);
                ctx.lineTo(ex + el.w, ey + yOffsets[r]);
                ctx.stroke();
            }
            
            // Draw vertical dividers
            for (let c = 1; c < colWidths.length; c++) {
                ctx.beginPath();
                ctx.moveTo(ex + xOffsets[c], ey);
                ctx.lineTo(ex + xOffsets[c], ey + el.h);
                ctx.stroke();
            }
            
            // Draw header background
            ctx.fillStyle = isDark ? 'rgba(99,102,241,0.12)' : 'rgba(99,102,241,0.06)';
            ctx.fillRect(ex, ey, el.w, rowHeights[0]);
            
            // Draw header text
            ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
            ctx.font = 'bold 11px Outfit, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            data.headers.forEach((hVal, c) => {
                ctx.fillText(hVal, ex + xOffsets[c] + 6, ey + yOffsets[0] + rowHeights[0] / 2);
            });
            
            // Draw body cells text
            ctx.font = '11px Outfit, sans-serif';
            data.rows.forEach((row, r) => {
                row.forEach((cellVal, c) => {
                    ctx.fillText(cellVal, ex + xOffsets[c] + 6, ey + yOffsets[r + 1] + rowHeights[r + 1] / 2);
                });
            });
            
            ctx.textBaseline = 'alphabetic'; // Reset baseline
        }
        
        else if (el.type === 'text') {
            ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
            ctx.font = 'bold 16px Outfit, sans-serif';
            ctx.fillText(el.content || 'Header Text', ex, ey + 24);
        }
    });
    
    // Trigger download hook
    const a = document.createElement('a');
    a.href = expCanvas.toDataURL('image/png');
    a.download = `Mairo_Whiteboard_${state.template}_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// Helpers for canvas drawing export
function getStickyColorCode(col) {
    const codes = { yellow:'#fef08a', pink:'#fbcfe8', green:'#bbf7d0', blue:'#bfdbfe', purple:'#e9d5ff', orange:'#fed7aa' };
    return codes[col] || '#fef08a';
}
function getCategoryColorCode(cat) {
    const codes = { story:'#38bdf8', feature:'#fb923c', dependency:'#f87171', risk:'#facc15', milestone:'#e9d5ff' };
    return codes[cat] || '#6366f1';
}
function getStatusColorCode(stat) {
    const codes = { todo:'#64748b', doing:'#06b6d4', blocked:'#ef4444', done:'#10b981' };
    return codes[stat] || '#64748b';
}
function wrapText(context, text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    let currY = y;
    
    for (let n = 0; n < words.length; n++) {
        let testLine = line + words[n] + ' ';
        let metrics = context.measureText(testLine);
        let testWidth = metrics.width;
        if (testWidth > maxWidth && n > 0) {
            context.fillText(line, x, currY);
            line = words[n] + ' ';
            currY += lineHeight;
        } else {
            line = testLine;
        }
    }
    context.fillText(line, x, currY);
}

// --- Dynamic Notification Toast ---
function showToast(msg) {
    // Remove existing
    const prior = document.querySelector('.toast-banner');
    if (prior) prior.remove();
    
    const toast = document.createElement('div');
    toast.className = 'toast-banner';
    toast.textContent = msg;
    
    // Inline quick styling to avoid stylesheet clutter
    Object.assign(toast.style, {
        position: 'absolute',
        bottom: '70px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(15,23,42,0.9)',
        color: '#ffffff',
        border: '1px solid rgba(255,255,255,0.1)',
        padding: '8px 18px',
        borderRadius: '20px',
        fontFamily: 'Outfit, sans-serif',
        fontSize: '13px',
        fontWeight: '500',
        zIndex: '1000',
        boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
        transition: 'opacity 0.3s ease',
        pointerEvents: 'none'
    });
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// --- Wire Event Handlers & Hooks ---

function registerEventListeners() {
    // Floating Contextual Toolbar buttons
    document.getElementById('btn-font-dec').addEventListener('click', () => changeFontSize('dec'));
    document.getElementById('btn-font-inc').addEventListener('click', () => changeFontSize('inc'));
    
    document.getElementById('btn-line-solid').addEventListener('click', () => setLineStyle('solid'));
    document.getElementById('btn-line-dashed').addEventListener('click', () => setLineStyle('dashed'));
    document.getElementById('btn-line-dotted').addEventListener('click', () => setLineStyle('dotted'));
    
    document.querySelectorAll('.color-picker-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            const color = e.target.dataset.color;
            changeColor(color);
        });
    });
    
    document.getElementById('btn-context-delete').addEventListener('click', () => {
        if (selectedElementId) {
            deleteElement(selectedElementId);
        } else if (selectedDependencyId) {
            deleteDependency(selectedDependencyId);
        }
    });

    const btnRowAdd = document.getElementById('btn-table-row-add');
    const btnRowDel = document.getElementById('btn-table-row-del');
    const btnColAdd = document.getElementById('btn-table-col-add');
    const btnColDel = document.getElementById('btn-table-col-del');
    
    if (btnRowAdd) btnRowAdd.addEventListener('click', addTableRow);
    if (btnRowDel) btnRowDel.addEventListener('click', deleteTableRow);
    if (btnColAdd) btnColAdd.addEventListener('click', addTableColumn);
    if (btnColDel) btnColDel.addEventListener('click', deleteTableColumn);

    // Tool selection clicks
    const toolButtons = document.querySelectorAll('.tool-btn');
    toolButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            toolButtons.forEach(b => b.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            
            currentTool = target.dataset.tool;
            document.getElementById('canvas-status').textContent = `${currentTool.toUpperCase()} Tool Active`;
            
            // Clean up selections
            connectSourceId = null;
            selectedElementId = null;
            selectedDependencyId = null;
            renderWorkspace();
            
            // Adapt cursor look
            if (currentTool === 'select') {
                container.style.cursor = 'default';
            } else {
                container.style.cursor = 'crosshair';
            }
        });
    });
    
    // Zoom click events
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
        const bounds = container.getBoundingClientRect();
        handleZoom(1, bounds.left + bounds.width/2, bounds.top + bounds.height/2);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
        const bounds = container.getBoundingClientRect();
        handleZoom(-1, bounds.left + bounds.width/2, bounds.top + bounds.height/2);
    });
    document.getElementById('btn-zoom-reset').addEventListener('click', () => {
        state.zoom = 1;
        state.pan = { x: 200, y: 100 };
        updateCanvasTransform();
        saveToLocalStorage();
    });
    
    // Canvas click spawning/drawing triggers
    canvas.addEventListener('mousedown', (e) => {
        // Drawing brush / Line triggers
        if (currentTool === 'draw' || currentTool === 'line') {
            isDrawing = true;
            const coords = clientToCanvasCoords(e.clientX, e.clientY);
            
            const strokeId = 'stroke-' + Date.now();
            currentStroke = {
                id: strokeId,
                points: currentTool === 'line' ? [coords, coords] : [coords],
                color: document.body.classList.contains('light-theme') ? '#4f46e5' : '#6366f1',
                width: 4,
                isLine: currentTool === 'line'
            };
            state.drawings.push(currentStroke);
            
            // Quick local SVG element insertion for responsive line tracing
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('id', strokeId);
            path.setAttribute('d', `M ${coords.x} ${coords.y} L ${coords.x} ${coords.y}`);
            path.setAttribute('stroke', currentStroke.color);
            path.setAttribute('stroke-width', currentStroke.width);
            path.setAttribute('fill', 'none');
            path.setAttribute('class', currentTool === 'line' ? 'drawing-line' : 'drawing-stroke');
            svgLayer.appendChild(path);
            
            e.stopPropagation();
            return;
        }
        
        // Canvas clicks deselect element or dependency
        if (currentTool === 'select') {
            const hitBoardElement = e.target.closest('.board-element');
            const hitToolbar = e.target.closest('#context-toolbar');
            if (!hitBoardElement && !hitToolbar) {
                selectedElementId = null;
                selectedDependencyId = null;
                domContainer.querySelectorAll('.board-element').forEach(el => el.classList.remove('selected'));
                renderDependencies();
                updateContextToolbar();
            }
        }
        
        // Drag-to-draw Box shape trigger
        if (currentTool === 'box') {
            isDrawingBox = true;
            boxStartCoords = clientToCanvasCoords(e.clientX, e.clientY);
            const id = 'box-' + Date.now();
            currentBoxElement = {
                id,
                type: 'box',
                x: boxStartCoords.x,
                y: boxStartCoords.y,
                w: 1,
                h: 1,
                content: ''
            };
            state.elements.push(currentBoxElement);
            renderElements();
            e.stopPropagation();
            return;
        }
        
        // Panning operations triggers (Spacebar check or middle/right mouse key)
        const isRightClick = e.button === 2;
        const isMiddleClick = e.button === 1;
        const isSpacePressed = window.isSpaceBarDown; // tracking global keys
        
        if (currentTool === 'select' && (isRightClick || isMiddleClick || isSpacePressed)) {
            e.preventDefault();
            handlePanStart(e.clientX, e.clientY);
            return;
        }
        
        // Creation clicks
        if (e.target === domContainer || e.target === canvas || e.target === svgLayer || e.target.classList.contains('pb-cell')) {
            const coords = clientToCanvasCoords(e.clientX, e.clientY);
            
            if (currentTool === 'sticky') {
                addSticky(coords.x - 75, coords.y - 75);
                document.getElementById('tool-select').click();
            } else if (currentTool === 'card') {
                addTaskCard(coords.x - 110, coords.y - 62);
                document.getElementById('tool-select').click();
            } else if (currentTool === 'text') {
                addTextLabel(coords.x - 125, coords.y - 18);
                document.getElementById('tool-select').click();
            } else if (currentTool === 'table') {
                addTable(coords.x - 200, coords.y - 100);
                document.getElementById('tool-select').click();
            }
        }
    });
    
    document.addEventListener('mousemove', (e) => {
        if (isDrawing && currentStroke) {
            const coords = clientToCanvasCoords(e.clientX, e.clientY);
            const path = document.getElementById(currentStroke.id);
            
            if (currentStroke.isLine) {
                currentStroke.points[1] = coords;
                if (path) {
                    path.setAttribute('d', `M ${currentStroke.points[0].x} ${currentStroke.points[0].y} L ${coords.x} ${coords.y}`);
                }
            } else {
                currentStroke.points.push(coords);
                if (path) {
                    let d = path.getAttribute('d');
                    d += ` L ${coords.x} ${coords.y}`;
                    path.setAttribute('d', d);
                }
            }
            return;
        }
        
        // Drag-to-draw Box shape update
        if (isDrawingBox && currentBoxElement) {
            const coords = clientToCanvasCoords(e.clientX, e.clientY);
            const x = Math.min(boxStartCoords.x, coords.x);
            const y = Math.min(boxStartCoords.y, coords.y);
            const w = Math.max(10, Math.abs(coords.x - boxStartCoords.x));
            const h = Math.max(10, Math.abs(coords.y - boxStartCoords.y));
            
            currentBoxElement.x = x;
            currentBoxElement.y = y;
            currentBoxElement.w = w;
            currentBoxElement.h = h;
            
            const domEl = domContainer.querySelector(`[data-id="${currentBoxElement.id}"]`);
            if (domEl) {
                domEl.style.left = `${x}px`;
                domEl.style.top = `${y}px`;
                domEl.style.width = `${w}px`;
                domEl.style.height = `${h}px`;
            }
            return;
        }
        handlePanMove(e.clientX, e.clientY);
    });
    
    document.addEventListener('mouseup', () => {
        if (isDrawing) {
            isDrawing = false;
            currentStroke = null;
            pushState();
            renderWorkspace(); // Full redraw to map eraser events to path
            return;
        }
        
        if (isDrawingBox && currentBoxElement) {
            isDrawingBox = false;
            // If the box is too small, discard it as a click anomaly
            if (currentBoxElement.w < 20 || currentBoxElement.h < 20) {
                state.elements = state.elements.filter(el => el.id !== currentBoxElement.id);
            } else {
                pushState();
            }
            currentBoxElement = null;
            renderWorkspace();
            document.getElementById('tool-select').click();
            return;
        }
        
        handlePanEnd();
    });
    
    // Zoom scrolling wheel hook
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        handleZoom(-e.deltaY, e.clientX, e.clientY);
    }, { passive: false });
    
    // Keyboard Spacebar hold hooks for panning shortcuts
    window.isSpaceBarDown = false;
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
            window.isSpaceBarDown = true;
            container.style.cursor = 'grab';
        }
        // Undo shortcut
        if (e.ctrlKey && e.code === 'KeyZ') {
            e.preventDefault();
            undo();
        }
        // Redo shortcut
        if (e.ctrlKey && e.code === 'KeyY') {
            e.preventDefault();
            redo();
        }
        // Esc cancels link selections
        if (e.code === 'Escape') {
            connectSourceId = null;
            selectedElementId = null;
            renderWorkspace();
        }
        // Backspace or Delete deletes selected element or dependency
        if (e.code === 'Delete' || e.code === 'Backspace') {
            if (document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
                if (selectedElementId) {
                    e.preventDefault();
                    deleteElement(selectedElementId);
                    selectedElementId = null;
                } else if (selectedDependencyId) {
                    e.preventDefault();
                    deleteDependency(selectedDependencyId);
                    selectedDependencyId = null;
                }
            }
        }
        
        // Single Key shortcuts
        if (document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
            if (e.key.toLowerCase() === 'v') document.getElementById('tool-select').click();
            if (e.key.toLowerCase() === 's') document.getElementById('tool-sticky').click();
            if (e.key.toLowerCase() === 'c') document.getElementById('tool-card').click();
            if (e.key.toLowerCase() === 'b') document.getElementById('tool-box').click();
            if (e.key.toLowerCase() === 'i') document.getElementById('tool-line').click();
            if (e.key.toLowerCase() === 'd') document.getElementById('tool-draw').click();
            if (e.key.toLowerCase() === 't') document.getElementById('tool-text').click();
            if (e.key.toLowerCase() === 'e') document.getElementById('tool-eraser').click();
            if (e.key.toLowerCase() === 'g') document.getElementById('tool-table').click();
        }
    });
    
    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            window.isSpaceBarDown = false;
            container.style.cursor = currentTool === 'select' ? 'default' : 'crosshair';
        }
    });
    
    // Prevent right click menu trigger on canvas container during panning
    container.addEventListener('contextmenu', e => e.preventDefault());
    
    // Backlog drawer sidebar toggle click
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        document.getElementById('sidebar-drawer').classList.toggle('closed');
    });
    
    // Sidebar Tabs switching
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(btn => {
        btn.addEventListener('click', (e) => {
            tabs.forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(e.target.dataset.tab).classList.add('active');
        });
    });
    
    // Config Panel active template selections change
    document.getElementById('config-template-select').addEventListener('change', (e) => {
        state.template = e.target.value;
        pushState();
        renderWorkspace();
        renderConfigOptions();
    });
    
    // Spawning buttons
    document.getElementById('btn-add-backlog').addEventListener('click', () => {
        const id = 'card-b' + Date.now();
        state.backlog.push({
            id,
            type: 'story',
            key: 'TASK-' + Math.floor(Math.random() * 900 + 100),
            title: 'New Backlog Item',
            desc: '',
            points: '3',
            owner: 'Assignee',
            status: 'backlog',
            team: ''
        });
        pushState();
        renderBacklog();
    });
    
    // Template selection modal trigger
    document.getElementById('btn-templates').addEventListener('click', () => {
        // preselect card styling inside modal
        const cards = document.querySelectorAll('.template-grid .template-card');
        cards.forEach(c => {
            if (c.dataset.template === state.template) {
                c.classList.add('active');
            } else {
                c.classList.remove('active');
            }
        });
        document.getElementById('templates-modal').classList.add('show');
    });
    
    document.getElementById('btn-close-templates').addEventListener('click', () => {
        document.getElementById('templates-modal').classList.remove('show');
    });
    
    // Select styling templates inside modal grid click
    document.querySelectorAll('.template-grid .template-card').forEach(card => {
        card.addEventListener('click', (e) => {
            document.querySelectorAll('.template-grid .template-card').forEach(c => c.classList.remove('active'));
            e.currentTarget.classList.add('active');
        });
    });
    
    // Apply template click
    document.getElementById('btn-apply-template').addEventListener('click', () => {
        const activeCard = document.querySelector('.template-grid .template-card.active');
        if (activeCard) {
            state.template = activeCard.dataset.template;
            document.getElementById('config-template-select').value = state.template;
            document.getElementById('templates-modal').classList.remove('show');
            pushState();
            renderWorkspace();
            renderConfigOptions();
        }
    });
    
    // Action undo/redo button triggers
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
    
    // Theme toggle button click
    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
        if (document.body.classList.contains('light-theme')) {
            document.body.className = 'dark-theme';
            localStorage.setItem('mairo_theme', 'dark-theme');
        } else {
            document.body.className = 'light-theme';
            localStorage.setItem('mairo_theme', 'light-theme');
        }
    });
    
    // Export dropdown toggle trigger
    const exportBtn = document.getElementById('btn-export-menu');
    const dropdown = document.getElementById('export-dropdown');
    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('show');
    });
    
    // Close dropdown on click outside
    window.addEventListener('click', () => {
        dropdown.classList.remove('show');
    });
    
    // Clear workspace canvas confirmation trigger
    document.getElementById('btn-clear-board').addEventListener('click', () => {
        if (confirm("Are you sure you want to completely erase the workspace (elements, drawing paths, and backlog cards)?")) {
            state.elements = [];
            state.dependencies = [];
            state.drawings = [];
            state.backlog = [];
            pushState();
            renderWorkspace();
            renderBacklog();
        }
    });
    
    // Exporter buttons clicks
    document.getElementById('btn-export-json').addEventListener('click', exportToJSON);
    document.getElementById('btn-export-png').addEventListener('click', downloadPNGImage);
    
    // Importer triggers
    document.getElementById('btn-import-json-trigger').addEventListener('click', () => {
        document.getElementById('btn-import-json').click();
    });
    document.getElementById('btn-import-json').addEventListener('change', handleJSONImport);
    
    // Modal buttons actions
    document.getElementById('btn-close-edit').addEventListener('click', closeEditModal);
    document.getElementById('btn-cancel-edit').addEventListener('click', closeEditModal);
    document.getElementById('btn-save-card').addEventListener('click', saveCardDetails);
    
    // Modal Delete element button click
    document.getElementById('btn-delete-card').addEventListener('click', () => {
        const id = document.getElementById('edit-card-id-raw').value;
        if (id) {
            deleteElement(id);
            closeEditModal();
        }
    });
}

// --- Initialize App ---
document.addEventListener('DOMContentLoaded', () => {
    // Synchronize saved theme preference
    const savedTheme = localStorage.getItem('mairo_theme');
    if (savedTheme === 'dark-theme') {
        document.body.className = 'dark-theme';
    } else {
        document.body.className = 'light-theme';
    }
    
    loadFromLocalStorage();
    updateCanvasTransform();
    registerEventListeners();
    setupHTML5DragNDrop();
    renderWorkspace();
    renderBacklog();
    renderConfigOptions();
    
    // Close loading splash if any
    showToast("Mairo Whiteboard Initialized. Press V, S, C, L, D to swap tools.");
});
