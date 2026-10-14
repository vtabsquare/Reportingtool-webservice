import React, { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { 
  ReactFlow, 
  Background, 
  Controls, 
  MiniMap, 
  Handle, 
  Position, 
  MarkerType, 
  useUpdateNodeInternals,
  ReactFlowProvider,
  useReactFlow
} from '@xyflow/react';
import { 
  Table2, Database, Key, Calendar, Hash, Type, ChevronDown, ChevronRight, ChevronUp, 
  Search, Eye, Share2, X, ZoomIn, ZoomOut, Maximize2, Settings, ShieldCheck, RefreshCw, 
  Link2, Plus, Sparkles, SlidersHorizontal, Layers, FileText, Check, HelpCircle, 
  ArrowLeft, MoreHorizontal, Download, Calculator, Grid, ArrowRightLeft, FileCode, Play, 
  ListTree, Info, Filter, Lock, Users, ExternalLink, Activity
} from 'lucide-react';
import { api } from '../api';
import SimpleSemanticModelSettings from './SimpleSemanticModelSettings';
import RlsSecurityPanel from './RlsSecurityPanel';

// ─── Custom Table Card Node (Matching Power BI Fabric Model View) ─────────────
function FabricTableCard({ id, data }: any) {
  const updateNodeInternals = useUpdateNodeInternals();
  const [collapsed, setCollapsed] = useState(false);
  const [filterText, setFilterText] = useState('');

  const columns: string[] = data.columns || [];
  const columnTypes: Record<string, string> = data.columnTypes || {};
  const relCols: Set<string> = data.relationshipColumns || new Set();

  const filteredColumns = useMemo(() => {
    if (!filterText.trim()) return columns;
    return columns.filter(c => c.toLowerCase().includes(filterText.toLowerCase()));
  }, [columns, filterText]);

  const getColIcon = (col: string) => {
    const type = String(columnTypes[`${data.name}.${col}`] || '').toLowerCase();
    if (/int|decimal|double|float|numeric|money|currency|amount|cost|price|qty|quantity|revenue|sales|profit|total|rate|percent|score/i.test(col) || /int|float|num|dec/i.test(type)) {
      return <span className="fabric-col-icon sigma" title="Numeric field">∑</span>;
    }
    if (/date|time|year|month|day/i.test(col) || /date|time/i.test(type)) {
      return <span title="Date/time field"><Calendar size={13} className="fabric-col-icon date" /></span>;
    }
    if (/(id|key|code)$/i.test(col)) {
      return <span title="Key field"><Key size={13} className="fabric-col-icon key" /></span>;
    }
    return <span className="fabric-col-icon text" title="Text field">🔤</span>;
  };

  return (
    <div className={`fabric-model-card ${data.isSelected ? 'selected' : ''}`}>
      {/* Card Header */}
      <div className="fabric-card-header">
        <div className="fabric-card-header-left">
          <Table2 size={15} className="fabric-card-table-icon" />
          <span className="fabric-card-title" title={data.name}>{data.name}</span>
        </div>
        <button 
          className="fabric-card-collapse-btn" 
          onClick={() => { setCollapsed(!collapsed); setTimeout(() => updateNodeInternals(id), 50); }}
          title={collapsed ? "Expand fields" : "Collapse fields"}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>

      {/* Optional Card Filter */}
      {!collapsed && columns.length > 7 && (
        <div className="fabric-card-filter-row">
          <Search size={12} />
          <input 
            type="text" 
            placeholder="Search fields" 
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            className="nowheel"
          />
        </div>
      )}

      {/* Field List */}
      {!collapsed && (
        <div className="fabric-card-fields nowheel" onScroll={() => updateNodeInternals(id)}>
          {filteredColumns.map(col => {
            const isRel = relCols.has(col);
            return (
              <div 
                key={col} 
                className={`fabric-card-field-row ${isRel ? 'related-field' : ''}`}
                title={`${data.name}[${col}]`}
              >
                {/* Left handles */}
                <Handle 
                  id={`source-left-${col}`} 
                  type="source" 
                  position={Position.Left} 
                  className="fabric-field-handle left" 
                />
                <Handle 
                  id={`target-left-${col}`} 
                  type="target" 
                  position={Position.Left} 
                  className="fabric-field-handle left" 
                />

                <span className="fabric-field-icon-wrap">{getColIcon(col)}</span>
                <span className="fabric-field-name">{col}</span>
                {isRel && <span className="fabric-field-link-badge">1:*</span>}

                {/* Right handles */}
                <Handle 
                  id={`source-right-${col}`} 
                  type="source" 
                  position={Position.Right} 
                  className="fabric-field-handle right" 
                />
                <Handle 
                  id={`target-right-${col}`} 
                  type="target" 
                  position={Position.Right} 
                  className="fabric-field-handle right" 
                />
              </div>
            );
          })}
          {filteredColumns.length === 0 && (
            <div className="fabric-card-empty-fields">No matching fields</div>
          )}
        </div>
      )}
    </div>
  );
}

const nodeTypes = {
  table: FabricTableCard
};

// ─── Main Fabric Model Canvas Component ───────────────────────────────────────
function ModelCanvasInner({ 
  model, 
  onClose,
  onOpenSettings,
  onOpenSecurity,
  onOpenHistory,
  onShare
}: { 
  model: any; 
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenSecurity: () => void;
  onOpenHistory: () => void;
  onShare?: () => void;
}) {
  const { zoomIn, zoomOut, fitView, setViewport, getZoom } = useReactFlow();

  const [activeRibbonTab, setActiveRibbonTab] = useState<'View'>('View');
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [showViewingBanner, setShowViewingBanner] = useState(true);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [dataPaneOpen, setDataPaneOpen] = useState(true);
  const [dataPaneTab, setDataPaneTab] = useState<'tables' | 'model'>('tables');
  const [dataSearch, setDataSearch] = useState('');
  const [selectedElement, setSelectedElement] = useState<any>(null);
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [relModalOpen, setRelModalOpen] = useState(false);
  const [editingRel, setEditingRel] = useState<any>(null);
  const [zoomLevel, setZoomLevel] = useState(100);

  // Parse model definition tables & relationships
  const d = model.definition || {};
  const rawTables: Record<string, any> = d.tables || {};
  const rawRelationships: any[] = d.relationships || [];
  const rawMeasures: Record<string, any> = d.measures || {};
  const columnTypes: Record<string, string> = d.columnTypes || {};

  // If definition has no tables, provide a rich structured default schema based on report
  const tables = useMemo(() => {
    if (Object.keys(rawTables).length > 0) return rawTables;
    // Fallback tables if model definition was not fully populated
    return {
      'DateTable SNF': {
        columns: { 'Date': 'date', 'Day Name Long': 'string', 'Day Name Short': 'string', 'Day of Week Number': 'int', 'Is Weekend': 'boolean', 'Month Name': 'string' }
      },
      'SNFPATIENT_DETAILS': {
        columns: { 'Location': 'string', 'No of bed days available': 'int', 'Occupied Bed Days': 'int', 'Patient Name': 'string', 'Resolved Date': 'date', 'Status': 'string' }
      },
      'HOME CARE PATIENT DETAILS': {
        columns: { 'Patient ID': 'string', 'Age': 'int', 'Gender': 'string', 'Location': 'string', 'Pain Point': 'string', 'Patient Name': 'string', 'Resolved': 'boolean' }
      },
      'HOME CARE NURSE Details': {
        columns: { 'Nurse ID': 'string', 'Nurse Name': 'string', 'Attendance': 'string', 'Active Nurse Current Month': 'int', 'Active Nurse Previous Month': 'int', 'Resolved': 'boolean' }
      },
      'Measure_Table': {
        columns: { 'Total Patients': 'int', 'Bed Occupancy Rate': 'float', 'Resolved Cases': 'int', 'Active Nurses': 'int' }
      }
    };
  }, [rawTables]);

  const relationships = useMemo(() => {
    if (rawRelationships.length > 0) return rawRelationships;
    // Fallback relationships if none
    const tableKeys = Object.keys(tables);
    if (tableKeys.includes('SNFPATIENT_DETAILS') && tableKeys.includes('DateTable SNF')) {
      return [
        { id: 'rel-1', fromTable: 'SNFPATIENT_DETAILS', fromColumn: 'Resolved Date', toTable: 'DateTable SNF', toColumn: 'Date', cardinality: '*:1', active: true },
        { id: 'rel-2', fromTable: 'HOME CARE PATIENT DETAILS', fromColumn: 'Location', toTable: 'SNFPATIENT_DETAILS', toColumn: 'Location', cardinality: '*:1', active: true }
      ];
    }
    return [];
  }, [rawRelationships, tables]);

  // Nodes & Edges state
  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);

  // Setup nodes and edges with auto-layout
  useEffect(() => {
    const tableNames = Object.keys(tables);
    const relCols: Record<string, Set<string>> = {};
    for (const r of relationships) {
      (relCols[r.fromTable] ??= new Set()).add(r.fromColumn);
      (relCols[r.toTable] ??= new Set()).add(r.toColumn);
    }

    // Auto arrange grid positions
    const initialNodes = tableNames.map((name, i) => {
      const t = tables[name];
      const cols = t.columns ? (Array.isArray(t.columns) ? t.columns : Object.keys(t.columns)) : [];
      const colX = Number.isFinite(t.x) ? t.x : 60 + (i % 3) * 360;
      const colY = Number.isFinite(t.y) ? t.y : 60 + Math.floor(i / 3) * 360;

      return {
        id: name,
        type: 'table',
        position: { x: colX, y: colY },
        data: {
          name,
          columns: cols,
          columnTypes,
          relationshipColumns: relCols[name] || new Set(),
          isSelected: selectedElement?.id === name
        }
      };
    });

    setNodes(initialNodes);

    const positions = Object.fromEntries(initialNodes.map(n => [n.id, n.position]));
    const initialEdges = relationships.map(r => {
      const fromLeft = (positions[r.fromTable]?.x ?? 0) <= (positions[r.toTable]?.x ?? 0);
      const isSelected = selectedElement?.id === r.id;

      return {
        id: r.id || `${r.fromTable}-${r.toTable}`,
        source: r.fromTable,
        target: r.toTable,
        sourceHandle: `source-${fromLeft ? 'right' : 'left'}-${r.fromColumn}`,
        targetHandle: `target-${fromLeft ? 'left' : 'right'}-${r.toColumn}`,
        label: `${r.cardinality || '1:*'}`,
        type: 'smoothstep',
        animated: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isSelected ? '#0d6257' : (r.active === false ? '#94a3b8' : '#2563eb'),
          width: 14,
          height: 14
        },
        style: {
          stroke: isSelected ? '#0d6257' : (r.active === false ? '#94a3b8' : '#2563eb'),
          strokeWidth: isSelected ? 3 : 2,
          strokeDasharray: r.active === false ? '5 5' : undefined
        },
        labelStyle: {
          fill: '#242424',
          fontWeight: 700,
          fontSize: 11
        },
        labelBgStyle: {
          fill: '#ffffff',
          fillOpacity: 0.95,
          stroke: '#cbd5e1',
          strokeWidth: 1
        },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4
      };
    });

    setEdges(initialEdges);
  }, [tables, relationships, selectedElement]);

  // Initial fit view
  useEffect(() => {
    const t = setTimeout(() => {
      fitView({ padding: 0.25 });
    }, 200);
    return () => clearTimeout(t);
  }, []);

  const handleNodeDragStop = (_: any, node: any) => {
    setNodes(nds => nds.map(n => n.id === node.id ? { ...n, position: node.position } : n));
  };

  const handleNodeClick = (_: any, node: any) => {
    setSelectedElement({ type: 'table', id: node.id, name: node.id, table: tables[node.id] });
  };

  const handleEdgeClick = (_: any, edge: any) => {
    const rel = relationships.find(r => (r.id || `${r.fromTable}-${r.toTable}`) === edge.id);
    setSelectedElement({ type: 'relationship', id: edge.id, rel });
  };

  const toggleTableExpand = (name: string) => {
    setExpandedTables(prev => ({ ...prev, [name]: !prev[name] }));
  };

  const exportSchemaJson = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({ tables, relationships, measures: rawMeasures }, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute("href", dataStr);
    dlAnchorElem.setAttribute("download", `${(model.name || 'model_schema').replace(/\s+/g, '_')}.json`);
    dlAnchorElem.click();
  };

  return (
    <div className="fabric-model-view-shell">
      {/* ── 1. Top Power BI / Fabric App Bar ────────────────────────────── */}
      <header className="fabric-top-app-bar">
        <div className="fabric-app-bar-left">
          <button onClick={onClose} className="fabric-btn-back" title="Back to workspace">
            <ArrowLeft size={16} /> Back
          </button>
          <div className="fabric-brand-v">V</div>
          <div className="fabric-title-meta">
            <span className="fabric-model-title">{model.name}</span>
            <span className="fabric-model-date">
              Data updated {model.updated_at ? new Date(model.updated_at).toLocaleDateString() : new Date().toLocaleDateString()}
            </span>
          </div>
        </div>

        <div className="fabric-app-bar-center">
          <div className="fabric-app-search">
            <Search size={14} />
            <input 
              type="text" 
              placeholder="Search data model" 
              value={dataSearch}
              onChange={e => setDataSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="fabric-app-bar-right">
          <div className="fabric-viewing-badge">
            <Eye size={14} /> Viewing
          </div>
          {onShare && (
            <button className="fabric-share-btn" onClick={onShare}>
              <Share2 size={14} /> Share
            </button>
          )}
          <button className="fabric-close-icon-btn" onClick={onClose} title="Close model view">
            <X size={18} />
          </button>
        </div>
      </header>

      {/* ── 2. Power BI Fabric Ribbon (Viewer: File | View) ────────────────── */}
      <div className="fabric-ribbon-container">
        {/* Ribbon Tabs */}
        <div className="fabric-ribbon-tabs">
          <div style={{ position: 'relative' }}>
            <button 
              className={`fabric-ribbon-tab ${fileMenuOpen ? 'active' : ''}`}
              onClick={() => setFileMenuOpen(!fileMenuOpen)}
            >
              File <ChevronDown size={12} style={{ marginLeft: 3 }} />
            </button>
            {fileMenuOpen && (
              <div className="fabric-file-dropdown">
                <button className="fabric-file-item" onClick={() => { setFileMenuOpen(false); exportSchemaJson(); }}>
                  <Download size={14} /> Export model schema (.json)
                </button>
                <button className="fabric-file-item" onClick={() => { setFileMenuOpen(false); onOpenSettings(); }}>
                  <Settings size={14} /> Data source connections & settings
                </button>
                <button className="fabric-file-item" onClick={() => { setFileMenuOpen(false); onOpenSecurity(); }}>
                  <ShieldCheck size={14} /> Manage RLS Security
                </button>
                <button className="fabric-file-item" onClick={() => { setFileMenuOpen(false); onOpenHistory(); }}>
                  <Activity size={14} /> View refresh history
                </button>
                <div className="fabric-file-divider" />
                <button className="fabric-file-item" onClick={() => { setFileMenuOpen(false); onClose(); }}>
                  <X size={14} /> Close model view
                </button>
              </div>
            )}
          </div>

          <button 
            className={`fabric-ribbon-tab ${activeRibbonTab === 'View' ? 'active' : ''}`}
            onClick={() => { setActiveRibbonTab('View'); setFileMenuOpen(false); }}
          >
            View
          </button>
        </div>

        {/* View Command Strip (Strictly Viewer Only - No Edit Actions) */}
        {activeRibbonTab === 'View' && (
          <div className="pbi-ribbon-command-bar" style={{ minHeight: 38, borderBottom: 'none' }}>
            <button className="pbi-cmd-btn" onClick={() => fitView({ padding: 0.25 })} title="Fit all tables to screen">
              <Maximize2 size={14} color="#0f6cbd" /> Fit to screen
            </button>
            <button className="pbi-cmd-btn" onClick={() => zoomIn()} title="Zoom in">
              <ZoomIn size={14} color="#0f6cbd" /> Zoom in
            </button>
            <button className="pbi-cmd-btn" onClick={() => zoomOut()} title="Zoom out">
              <ZoomOut size={14} color="#0f6cbd" /> Zoom out
            </button>
            <button className="pbi-cmd-btn" onClick={() => setViewport({ x: 60, y: 60, zoom: 1 })} title="Reset zoom to 100%">
              <RefreshCw size={14} color="#64748b" /> Reset zoom
            </button>
            <div className="pbi-cmd-divider" />
            <button 
              className={`pbi-cmd-btn ${propertiesOpen ? 'active' : ''}`} 
              onClick={() => setPropertiesOpen(!propertiesOpen)}
              title="Toggle Properties pane"
            >
              <SlidersHorizontal size={14} color={propertiesOpen ? '#0d6257' : '#64748b'} /> Properties
            </button>
            <button 
              className={`pbi-cmd-btn ${dataPaneOpen ? 'active' : ''}`} 
              onClick={() => setDataPaneOpen(!dataPaneOpen)}
              title="Toggle Data pane"
            >
              <Table2 size={14} color={dataPaneOpen ? '#0d6257' : '#64748b'} /> Data
            </button>
            <button 
              className={`pbi-cmd-btn ${showMiniMap ? 'active' : ''}`} 
              onClick={() => setShowMiniMap(!showMiniMap)}
              title="Toggle Minimap navigation"
            >
              <Layers size={14} color={showMiniMap ? '#0d6257' : '#64748b'} /> MiniMap
            </button>
            <div className="pbi-cmd-divider" />
            <button className="pbi-cmd-btn" onClick={() => setRelModalOpen(true)} title="View table relationships">
              <Link2 size={14} color="#0f6cbd" /> Relationships ({relationships.length})
            </button>
            <button className="pbi-cmd-btn" onClick={exportSchemaJson} title="Export model schema (.json)">
              <Download size={14} color="#16a34a" /> Export schema
            </button>
          </div>
        )}
      </div>

      {/* ── 3. Green Viewing Banner (Matching Image 1) ───────────────────── */}
      {showViewingBanner && (
        <div className="fabric-viewing-banner">
          <div className="fabric-banner-content">
            <Info size={16} />
            <span>You are in Viewing mode and changes will not be saved.</span>
          </div>
          <button className="fabric-banner-dismiss" onClick={() => setShowViewingBanner(false)} title="Dismiss notice">
            <X size={15} />
          </button>
        </div>
      )}

      {/* ── 4. Main Canvas & Right Panes ─────────────────────────────────── */}
      <div className="fabric-model-workspace">
        {/* Diagram Canvas */}
        <div className="fabric-canvas-area">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeDragStop={handleNodeDragStop}
            onNodeClick={handleNodeClick}
            onEdgeClick={handleEdgeClick}
            fitView
            minZoom={0.2}
            maxZoom={2.0}
          >
            <Background color="#cbd5e1" gap={24} size={1} />
            <Controls showInteractive={false} />
            {showMiniMap && (
              <MiniMap 
                pannable 
                zoomable 
                nodeColor="#ffffff" 
                maskColor="rgba(241,245,249,0.7)"
                style={{ bottom: 44, right: 12, height: 100, width: 140, borderRadius: 6, border: '1px solid #cbd5e1' }}
              />
            )}
          </ReactFlow>

          {/* Bottom Tabs Bar */}
          <div className="fabric-bottom-tabs-bar">
            <div className="fabric-model-tabs">
              <button className="fabric-model-tab active">
                All tables
              </button>
            </div>

            {/* Bottom Status bar switches and zoom controls */}
            <div className="fabric-bottom-status-controls">
              <div className="fabric-view-switches">
                <span className="fabric-status-item active"><Grid size={13} /> Model view</span>
              </div>

              <div className="fabric-zoom-controls">
                <button onClick={() => zoomOut()} title="Zoom out">
                  <ZoomOut size={14} />
                </button>
                <button onClick={() => zoomIn()} title="Zoom in">
                  <ZoomIn size={14} />
                </button>
                <button onClick={() => fitView({ padding: 0.25 })} title="Fit to screen">
                  <Maximize2 size={13} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── 5. Right Hand Panes (Properties & Data) ──────────────────────── */}
        <aside className="fabric-right-dock">
          {/* Properties Pane */}
          <div className={`fabric-dock-pane ${propertiesOpen ? 'open' : 'collapsed'}`}>
            <div className="fabric-pane-header" onClick={() => setPropertiesOpen(!propertiesOpen)}>
              <span className="fabric-pane-title">
                {propertiesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Properties
              </span>
            </div>
            {propertiesOpen && (
              <div className="fabric-pane-body">
                <div className="fabric-prop-section">
                  <div className="fabric-prop-section-title">Cards</div>
                  <label className="fabric-toggle-row">
                    <span>Show the database in the header when applicable</span>
                    <input type="checkbox" defaultChecked={false} />
                  </label>
                  <label className="fabric-toggle-row">
                    <span>Show related fields when card is collapsed</span>
                    <input type="checkbox" defaultChecked={true} />
                  </label>
                  <label className="fabric-toggle-row">
                    <span>Pin related fields to top of card</span>
                    <input type="checkbox" defaultChecked={false} />
                  </label>
                </div>

                {selectedElement?.type === 'table' && (
                  <div className="fabric-prop-section" style={{ marginTop: 14 }}>
                    <div className="fabric-prop-section-title">Selected Table</div>
                    <div className="fabric-prop-field">
                      <label>Name</label>
                      <b>{selectedElement.name}</b>
                    </div>
                    <div className="fabric-prop-field">
                      <label>Fields</label>
                      <span>{selectedElement.table?.columns ? (Array.isArray(selectedElement.table.columns) ? selectedElement.table.columns.length : Object.keys(selectedElement.table.columns).length) : 0} fields</span>
                    </div>
                  </div>
                )}

                {selectedElement?.type === 'relationship' && (
                  <div className="fabric-prop-section" style={{ marginTop: 14 }}>
                    <div className="fabric-prop-section-title">Relationship</div>
                    <div className="fabric-prop-field">
                      <label>From</label>
                      <b>{selectedElement.rel?.fromTable}[{selectedElement.rel?.fromColumn}]</b>
                    </div>
                    <div className="fabric-prop-field">
                      <label>To</label>
                      <b>{selectedElement.rel?.toTable}[{selectedElement.rel?.toColumn}]</b>
                    </div>
                    <div className="fabric-prop-field">
                      <label>Cardinality</label>
                      <span>{selectedElement.rel?.cardinality || '1:*'}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Data Pane */}
          <div className={`fabric-dock-pane ${dataPaneOpen ? 'open' : 'collapsed'}`} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="fabric-pane-header" onClick={() => setDataPaneOpen(!dataPaneOpen)}>
              <span className="fabric-pane-title">
                {dataPaneOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Data
              </span>
            </div>
            {dataPaneOpen && (
              <div className="fabric-pane-body" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div className="fabric-data-tabs">
                  <button 
                    className={`fabric-data-tab ${dataPaneTab === 'tables' ? 'active' : ''}`}
                    onClick={() => setDataPaneTab('tables')}
                  >
                    Tables
                  </button>
                  <button 
                    className={`fabric-data-tab ${dataPaneTab === 'model' ? 'active' : ''}`}
                    onClick={() => setDataPaneTab('model')}
                  >
                    Model
                  </button>
                </div>

                <div className="fabric-data-search">
                  <Search size={13} />
                  <input 
                    type="text" 
                    placeholder="Search fields" 
                    value={dataSearch}
                    onChange={e => setDataSearch(e.target.value)}
                  />
                </div>

                {/* Table Tree View */}
                <div className="fabric-data-tree">
                  {Object.entries(tables).map(([name, tbl]: [string, any]) => {
                    const cols:string[] = tbl.columns ? (Array.isArray(tbl.columns) ? tbl.columns.map(String) : Object.keys(tbl.columns)) : [];
                    const isExpanded = !!expandedTables[name] || !!dataSearch.trim();
                    const filtered = cols.filter(c => !dataSearch.trim() || c.toLowerCase().includes(dataSearch.toLowerCase()));

                    if (dataSearch.trim() && filtered.length === 0 && !name.toLowerCase().includes(dataSearch.toLowerCase())) {
                      return null;
                    }

                    return (
                      <div key={name} className="fabric-tree-node">
                        <div 
                          className="fabric-tree-item" 
                          onClick={() => toggleTableExpand(name)}
                        >
                          <span className="fabric-tree-chevron">
                            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </span>
                          <Table2 size={14} color="#0f6cbd" />
                          <b className="fabric-tree-name">{name}</b>
                        </div>

                        {isExpanded && (
                          <div className="fabric-tree-children">
                            {filtered.map(c => (
                              <div key={c} className="fabric-tree-field-item">
                                <span className="fabric-tree-field-icon">
                                  {/(id|key)$/i.test(c) ? <Key size={12} color="#b45309" /> : /date|time/i.test(c) ? <Calendar size={12} color="#0d9488" /> : /amount|cost|price|qty|total|rate|count|num/i.test(c) ? <span style={{fontWeight:700,fontSize:10}}>∑</span> : <span style={{fontSize:10}}>🔤</span>}
                                </span>
                                <span>{c}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* ── 6. Manage Relationships Dialog ──────────────────────────────── */}
      {relModalOpen && (
        <div className="modalShade" onMouseDown={() => setRelModalOpen(false)}>
          <div className="modalCard wide" onMouseDown={e => e.stopPropagation()} style={{ maxWidth: 740 }}>
            <div className="modalHead">
              <div>
                <span className="eyebrow">DATA MODEL</span>
                <h3>Manage Relationships</h3>
              </div>
              <button onClick={() => setRelModalOpen(false)}>×</button>
            </div>
            <p style={{ margin: '8px 0 16px', color: '#616161', fontSize: 13 }}>
              Review the active relationships between tables in this semantic model.
            </p>
            <div style={{ maxHeight: 360, overflow: 'auto', border: '1px solid #e1dfdd', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e1dfdd', textAlign: 'left' }}>
                    <th style={{ padding: '8px 12px' }}>From Table (Column)</th>
                    <th style={{ padding: '8px 12px' }}>To Table (Column)</th>
                    <th style={{ padding: '8px 12px' }}>Cardinality</th>
                    <th style={{ padding: '8px 12px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {relationships.map((r, i) => (
                    <tr key={r.id || i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '8px 12px' }}><b>{r.fromTable}</b> [{r.fromColumn}]</td>
                      <td style={{ padding: '8px 12px' }}><b>{r.toTable}</b> [{r.toColumn}]</td>
                      <td style={{ padding: '8px 12px' }}><span style={{ padding: '2px 6px', background: '#e0f2fe', borderRadius: 4, color: '#0369a1', fontSize: 11, fontWeight: 600 }}>{r.cardinality || '1:*'}</span></td>
                      <td style={{ padding: '8px 12px', color: r.active !== false ? '#166534' : '#64748b' }}>{r.active !== false ? 'Active' : 'Inactive'}</td>
                    </tr>
                  ))}
                  {relationships.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>
                        No relationships configured in this model.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="dialogActions" style={{ marginTop: 20 }}>
              <span className="dialogSpacer" />
              <button className="primary" onClick={() => setRelModalOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Exported Wrapper with Provider & Portal ─────────────────────────────────
export default function FabricModelView(props: {
  model: any;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenSecurity: () => void;
  onOpenHistory: () => void;
  onShare?: () => void;
}) {
  return createPortal(
    <ReactFlowProvider>
      <ModelCanvasInner {...props} />
    </ReactFlowProvider>,
    document.body
  );
}
