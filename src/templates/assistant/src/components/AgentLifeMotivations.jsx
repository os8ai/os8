import { useState, useEffect, useCallback } from 'react'

const inputClass = "w-full bg-gray-800 text-gray-200 text-xs rounded px-2 py-1.5 border border-gray-700 focus:outline-none focus:border-blue-500"

function parseMissions(content) {
  if (!content) return []
  const missions = []
  const lines = content.split('\n')
  let current = null
  for (const line of lines) {
    const match = line.match(/^## (.+)/)
    if (match) {
      if (current) missions.push(current)
      current = { name: match[1].trim(), description: '' }
    } else if (current) {
      current.description += (current.description ? '\n' : '') + line
    }
  }
  if (current) missions.push(current)
  return missions.map(m => ({ ...m, description: m.description.trim() }))
}

function serializeMissions(missions) {
  if (missions.length === 0) return ''
  return '# Motivations\n\n' + missions.map(m => `## ${m.name}\n\n${m.description}`).join('\n\n') + '\n'
}

function formatSchedule(schedule) {
  if (!schedule) return ''
  if (schedule.frequency === 'daily') return `Daily at ${schedule.time || '?'}`
  if (schedule.frequency === 'every-x-hours') return `Every ${schedule.interval}h`
  if (schedule.frequency === 'every-x-minutes') return `Every ${schedule.interval}m`
  return schedule.frequency
}

const JOB_DEFS = [
  { key: 'action-planner', label: 'Action Planner', desc: 'Agent reviews motivations and identifies jobs/actions to take', toggleable: true, editable: true },
  { key: 'agent-life', label: 'Agent Life', desc: 'Agent updates motivation progress as part of daily activities', toggleable: true, editable: true },
  { key: 'motivations-update', label: 'Motivations Update', desc: 'Agent assesses progress and shares update with user', toggleable: true, editable: true },
]

const FREQUENCIES = [
  { value: 'every-x-minutes', label: 'Every X minutes', hasInterval: true },
  { value: 'hourly', label: 'Hourly', hasTime: false },
  { value: 'daily', label: 'Daily', hasTime: true },
  { value: 'weekdays', label: 'Weekdays', hasTime: true },
  { value: 'weekly', label: 'Weekly', hasTime: true },
]

function JobScheduleModal({ job, label, agentId, baseApiUrl, onSaved, onClose }) {
  const [frequency, setFrequency] = useState(job.schedule?.frequency || 'daily')
  const [time, setTime] = useState(job.schedule?.time || '08:00')
  const [interval, setInterval] = useState(job.schedule?.interval || 60)

  const freqDef = FREQUENCIES.find(f => f.value === frequency)

  const handleSave = async () => {
    const schedule = { frequency }
    if (freqDef?.hasTime) schedule.time = time
    if (freqDef?.hasInterval) schedule.interval = Number(interval)
    if (frequency === 'hourly') schedule.minute = parseInt(time?.split(':')[1] || '0', 10)
    await fetch(`${baseApiUrl}/api/jobs/${agentId}/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule })
    })
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[360px] p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">{label}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">&times;</button>
        </div>
        <div className="space-y-3">
          <label className="block">
            <span className="text-[10px] text-gray-500">Frequency</span>
            <select value={frequency} onChange={e => setFrequency(e.target.value)}
              className={inputClass}>
              {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          {freqDef?.hasTime && (
            <label className="block">
              <span className="text-[10px] text-gray-500">Time</span>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} className={inputClass} />
            </label>
          )}
          {freqDef?.hasInterval && (
            <label className="block">
              <span className="text-[10px] text-gray-500">Interval (minutes)</span>
              <input type="number" min={1} value={interval} onChange={e => setInterval(e.target.value)} className={inputClass} />
            </label>
          )}
          {frequency === 'hourly' && (
            <label className="block">
              <span className="text-[10px] text-gray-500">Minute of hour</span>
              <input type="number" min={0} max={59} value={time?.split(':')[1] || '0'}
                onChange={e => setTime(`00:${e.target.value.padStart(2, '0')}`)} className={inputClass} />
            </label>
          )}
          <div className="flex gap-2 pt-1">
            <button onClick={handleSave} className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700 transition-colors">Save</button>
            <button onClick={onClose} className="text-xs text-gray-400 px-3 py-1 hover:text-gray-200 transition-colors">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MissionForm({ mission, onSave, onCancel }) {
  const [name, setName] = useState(mission?.name || '')
  const [description, setDescription] = useState(mission?.description || '')

  return (
    <div className="bg-gray-800 rounded-lg px-3 py-3 border border-blue-500/30 space-y-2">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Mission name" className={inputClass} autoFocus />
      <textarea value={description} onChange={e => setDescription(e.target.value)}
        placeholder="What's at stake? What does success look like?"
        className={`${inputClass} resize-y`} rows={3} />
      <div className="flex gap-2">
        <button onClick={() => { if (name.trim() && description.trim()) onSave({ name: name.trim(), description: description.trim() }) }}
          disabled={!name.trim() || !description.trim()}
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

export default function AgentLifeMotivations({ baseApiUrl, agentId }) {
  const [missions, setMissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingIndex, setEditingIndex] = useState(null)
  const [adding, setAdding] = useState(false)
  const [jobs, setJobs] = useState([])
  const [saved, setSaved] = useState(false)
  const [editingJobKey, setEditingJobKey] = useState(null)

  const showSaved = useCallback(() => {
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }, [])

  const loadData = useCallback(() => {
    if (!agentId) return
    Promise.all([
      fetch(`${baseApiUrl}/api/agent/${agentId}/motivations`).then(r => r.json()).catch(() => ({ content: '' })),
      fetch(`${baseApiUrl}/api/jobs/${agentId}`).then(r => r.json()).catch(() => [])
    ]).then(([motData, jobsData]) => {
      setMissions(parseMissions(motData.content))
      setJobs(Array.isArray(jobsData) ? jobsData : [])
      setLoading(false)
    })
  }, [baseApiUrl, agentId])

  useEffect(() => {
    setLoading(true)
    setEditingIndex(null)
    setAdding(false)
    loadData()
  }, [loadData])

  const saveMissions = async (updated) => {
    const content = serializeMissions(updated)
    await fetch(`${baseApiUrl}/api/agent/${agentId}/motivations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    })
    setMissions(updated)
    showSaved()
    // Reload jobs in case new ones were auto-provisioned
    fetch(`${baseApiUrl}/api/jobs/${agentId}`).then(r => r.json()).then(d => setJobs(Array.isArray(d) ? d : [])).catch(() => {})
  }

  const handleEditSave = (index, updated) => {
    const next = [...missions]
    next[index] = updated
    saveMissions(next)
    setEditingIndex(null)
  }

  const handleDelete = (index) => {
    if (!window.confirm(`Delete "${missions[index].name}"?`)) return
    const next = missions.filter((_, i) => i !== index)
    saveMissions(next)
  }

  const handleCreate = (mission) => {
    saveMissions([...missions, mission])
    setAdding(false)
  }

  const toggleJob = async (jobId) => {
    await fetch(`${baseApiUrl}/api/jobs/${agentId}/${jobId}/toggle`, { method: 'POST' })
    loadData()
  }

  const findJob = (key) => {
    return jobs.find(j =>
      j.skill === key || (j.name || '').toLowerCase().includes(key.replace('-', ' '))
    )
  }

  if (loading) return <p className="text-xs text-gray-500 animate-pulse">Loading motivations...</p>

  return (
    <div>
      {saved && (
        <div className="text-xs text-green-400 flex items-center gap-1 mb-2">
          <span>&#10003;</span> Saved
        </div>
      )}

      {/* Missions */}
      <div className="space-y-2">
        {missions.length === 0 && !adding && (
          <div className="text-center py-4">
            <p className="text-xs text-gray-500 mb-1">No motivations defined yet.</p>
            <p className="text-[10px] text-gray-600 mb-3">Add a mission to give this agent proactive goals.</p>
          </div>
        )}

        {missions.map((m, i) => (
          editingIndex === i ? (
            <MissionForm key={i} mission={m}
              onSave={(updated) => handleEditSave(i, updated)}
              onCancel={() => setEditingIndex(null)} />
          ) : (
            <div key={i} className="bg-gray-800/50 rounded-lg px-3 py-2 border border-gray-700/50">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-gray-200">{m.name}</span>
                  <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{m.description}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => { setAdding(false); setEditingIndex(i) }}
                    className="text-gray-500 hover:text-gray-300 text-[11px] p-1">Edit</button>
                  <button onClick={() => handleDelete(i)}
                    className="text-gray-500 hover:text-red-400 text-xs p-1">&times;</button>
                </div>
              </div>
            </div>
          )
        ))}

        {/* Add button */}
        <button
          onClick={() => { setEditingIndex(null); setAdding(true) }}
          className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors mt-1"
        >
          + Add mission
        </button>
      </div>

      {/* Add modal */}
      {adding && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={(e) => { if (e.target === e.currentTarget) setAdding(false) }}>
          <div className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-[420px] p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">New Mission</h2>
              <button onClick={() => setAdding(false)} className="text-gray-400 hover:text-white text-lg leading-none">&times;</button>
            </div>
            <MissionForm mission={null} onSave={handleCreate} onCancel={() => setAdding(false)} />
          </div>
        </div>
      )}

      {/* System Jobs */}
      {missions.length > 0 && (
        <div className="mt-4 pt-3 border-t border-gray-700/50">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">System Jobs</h3>
          <div className="space-y-2">
            {JOB_DEFS.map(def => {
              const job = findJob(def.key)
              return (
                <div key={def.key} className="flex items-center justify-between">
                  <div className="min-w-0">
                    <span className="text-xs text-gray-200">{def.label}</span>
                    <p className="text-[10px] text-gray-500">{def.desc}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    {job && (
                      <span className="text-[10px] text-gray-600">{formatSchedule(job.schedule)}</span>
                    )}
                    {job && def.editable && (
                      <button onClick={() => setEditingJobKey(def.key)}
                        className="text-gray-500 hover:text-gray-300 text-sm p-0.5" title="Edit schedule">
                        &#9998;
                      </button>
                    )}
                    {job && def.toggleable ? (
                      <button onClick={() => toggleJob(job.id)}
                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${job.enabled ? 'bg-green-600/20 text-green-400' : 'bg-gray-700 text-gray-500'}`}>
                        {job.enabled ? 'On' : 'Off'}
                      </button>
                    ) : job ? (
                      <span className={`text-[10px] px-2 py-0.5 rounded ${job.enabled ? 'bg-green-600/20 text-green-400' : 'bg-gray-700 text-gray-500'}`}>
                        {job.enabled ? 'On' : 'Off'}
                      </span>
                    ) : (
                      <span className="text-[10px] text-gray-600">Not provisioned</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Schedule edit modal */}
      {editingJobKey && (() => {
        const def = JOB_DEFS.find(d => d.key === editingJobKey)
        const job = def && findJob(def.key)
        if (!def || !job) return null
        return (
          <JobScheduleModal job={job} label={def.label} agentId={agentId} baseApiUrl={baseApiUrl}
            onSaved={() => { setEditingJobKey(null); loadData() }}
            onClose={() => setEditingJobKey(null)} />
        )
      })()}
    </div>
  )
}
