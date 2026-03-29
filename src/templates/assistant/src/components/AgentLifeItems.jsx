import { useState, useEffect, useCallback } from 'react'

const TYPES = [
  { key: 'setting', label: 'Settings', singular: 'setting' },
  { key: 'outfit', label: 'Outfits', singular: 'outfit' },
  { key: 'hairstyle', label: 'Hairstyles', singular: 'hairstyle' },
]

const inputClass = "w-full bg-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-700 focus:outline-none focus:border-blue-500"

function ItemCard({ item, activeType, onEdit, onDelete }) {
  return (
    <div className="bg-gray-800/50 rounded-lg px-3 py-2 border border-gray-700/50">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-200 truncate">{item.name}</span>
            {!!item.is_default && <span className="text-[9px] bg-blue-600/30 text-blue-400 px-1.5 rounded">default</span>}
          </div>
          <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{item.description}</p>
          {item.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {item.tags.map(t => <span key={t} className="text-[9px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">{t}</span>)}
            </div>
          )}
          {activeType === 'setting' && item.panoramic && (
            <p className="text-[10px] text-gray-600 mt-1 line-clamp-1 italic">{item.panoramic}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => onEdit(item)} className="text-gray-500 hover:text-gray-300 text-[11px] p-1">Edit</button>
          <button onClick={() => onDelete(item)} className="text-gray-500 hover:text-red-400 text-xs p-1">&times;</button>
        </div>
      </div>
    </div>
  )
}

function ItemForm({ item, activeType, onSave, onCancel }) {
  const [name, setName] = useState(item?.name || '')
  const [description, setDescription] = useState(item?.description || '')
  const [panoramic, setPanoramic] = useState(item?.panoramic || '')
  const [tags, setTags] = useState(item?.tags?.join(', ') || '')
  const [isDefault, setIsDefault] = useState(!!item?.is_default)

  const handleSubmit = () => {
    if (!name.trim() || !description.trim()) return
    const tagArray = tags.split(',').map(t => t.trim()).filter(Boolean)
    onSave({
      name: name.trim(),
      description: description.trim(),
      tags: tagArray,
      is_default: isDefault ? 1 : 0,
      ...(activeType === 'setting' ? { panoramic: panoramic.trim() || null } : {}),
    })
  }

  return (
    <div className="bg-gray-800 rounded-lg px-3 py-3 border border-blue-500/30 space-y-2">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className={inputClass} autoFocus />
      <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" className={inputClass} rows={3} />
      {activeType === 'setting' && (
        <textarea value={panoramic} onChange={e => setPanoramic(e.target.value)} placeholder="Panoramic — spatial layout from different angles" className={inputClass} rows={2} />
      )}
      <input value={tags} onChange={e => setTags(e.target.value)} placeholder="Tags (comma-separated)" className={inputClass} />
      <label className="flex items-center gap-2 text-[11px] text-gray-400 cursor-pointer">
        <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} className="rounded" />
        Default {activeType}
      </label>
      <div className="flex gap-2">
        <button onClick={handleSubmit} disabled={!name.trim() || !description.trim()}
          className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 disabled:opacity-50 transition-colors">
          Save
        </button>
        <button onClick={onCancel} className="text-xs text-gray-400 px-3 py-1 hover:text-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}

export default function AgentLifeItems({ baseApiUrl, agentId }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeType, setActiveType] = useState('setting')
  const [editingId, setEditingId] = useState(null)
  const [adding, setAdding] = useState(false)

  const loadItems = useCallback(() => {
    if (!agentId) return
    fetch(`${baseApiUrl}/api/agent/${agentId}/sim/life-items`)
      .then(r => r.json())
      .then(data => setItems(Array.isArray(data) ? data : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [baseApiUrl, agentId])

  useEffect(() => {
    setLoading(true)
    setEditingId(null)
    setAdding(false)
    loadItems()
  }, [loadItems])

  const handleEdit = (item) => {
    setAdding(false)
    setEditingId(item.id)
  }

  const handleSaveEdit = async (updates) => {
    await fetch(`${baseApiUrl}/api/agent/${agentId}/sim/life-items/${editingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    })
    setEditingId(null)
    loadItems()
  }

  const handleCreate = async (data) => {
    await fetch(`${baseApiUrl}/api/agent/${agentId}/sim/life-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: activeType, ...data, isDefault: data.is_default })
    })
    setAdding(false)
    loadItems()
  }

  const handleDelete = async (item) => {
    if (!window.confirm(`Delete "${item.name}"?`)) return
    await fetch(`${baseApiUrl}/api/agent/${agentId}/sim/life-items/${item.id}`, { method: 'DELETE' })
    loadItems()
  }

  const filtered = items.filter(i => i.type === activeType)
  const typeCounts = {}
  for (const t of TYPES) typeCounts[t.key] = items.filter(i => i.type === t.key).length

  if (loading) {
    return <p className="text-xs text-gray-500 animate-pulse">Loading items...</p>
  }

  const currentType = TYPES.find(t => t.key === activeType)

  return (
    <div>
      {/* Sub-tab bar */}
      <div className="flex gap-1 mb-3">
        {TYPES.map(t => (
          <button key={t.key}
            className={`text-[11px] px-2 py-1 rounded transition-colors ${activeType === t.key ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/40'}`}
            onClick={() => { setActiveType(t.key); setEditingId(null); setAdding(false) }}
          >{t.label} ({typeCounts[t.key]})</button>
        ))}
      </div>

      {/* Item list */}
      <div className="space-y-2">
        {filtered.length === 0 && !adding && (
          <p className="text-xs text-gray-500">No {currentType?.label.toLowerCase()} yet.</p>
        )}
        {filtered.map(item => (
          editingId === item.id ? (
            <ItemForm key={item.id} item={item} activeType={activeType}
              onSave={handleSaveEdit} onCancel={() => setEditingId(null)} />
          ) : (
            <ItemCard key={item.id} item={item} activeType={activeType}
              onEdit={handleEdit} onDelete={handleDelete} />
          )
        ))}

        {/* Add button */}
        <button
          onClick={() => { setEditingId(null); setAdding(true) }}
          className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors mt-1"
        >
          + Add {currentType?.singular}
        </button>
      </div>

      {/* Add modal */}
      {adding && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={(e) => { if (e.target === e.currentTarget) setAdding(false) }}>
          <div className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[420px] p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">New {currentType?.singular}</h2>
              <button onClick={() => setAdding(false)} className="text-gray-400 hover:text-white text-lg leading-none">&times;</button>
            </div>
            <ItemForm item={null} activeType={activeType}
              onSave={handleCreate} onCancel={() => setAdding(false)} />
          </div>
        </div>
      )}
    </div>
  )
}
