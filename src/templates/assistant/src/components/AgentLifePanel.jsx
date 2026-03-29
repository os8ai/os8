/**
 * AgentLifePanel — inline panel below chat showing agent memory context, images, and future tabs.
 * Replaces the former full-screen modal context viewer.
 */
import AgentLifeImages from './AgentLifeImages'
import AgentLifeMyself from './AgentLifeMyself'
import AgentLifeItems from './AgentLifeItems'
import AgentLifeMotivations from './AgentLifeMotivations'

/** Memory content sub-component — renders the context debug sections */
function MemoryContent({ contextData, contextTab, onTabChange }) {
  return (
    <>
      <p className="text-xs text-gray-500 mb-2">
        Assembled at {contextData.timestamp || '?'} &middot; Full context: {contextData.fullContext ? (contextData.fullContext.length / 1024).toFixed(1) : '0'}K chars
        {contextData.images?.length > 0 && ` \u00b7 ${contextData.images.length} image${contextData.images.length > 1 ? 's' : ''}`}
        {contextData.subconsciousEnabled && contextData.subconsciousDuration != null && ` \u00b7 Subconscious: ${contextData.subconsciousDuration}ms`}
        {contextData.subconsciousUsage && ` (${contextData.subconsciousUsage.input_tokens} in / ${contextData.subconsciousUsage.output_tokens} out)`}
      </p>
      {contextData.subconsciousEnabled && (
        <div className="flex gap-2 mb-3">
          <button
            className={`text-xs px-2.5 py-1 rounded transition-colors ${contextTab === 'conscious' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 bg-gray-700/40'}`}
            onClick={() => onTabChange('conscious')}
          >Conscious memory</button>
          <button
            className={`text-xs px-2.5 py-1 rounded transition-colors ${contextTab === 'raw' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 bg-gray-700/40'}`}
            onClick={() => onTabChange('raw')}
          >Raw subconscious</button>
        </div>
      )}
      {contextData.subconsciousEnabled && contextTab === 'conscious' && contextData.subconsciousClassification && (
        <div className={`text-xs font-semibold py-1.5 px-2 rounded mb-1 ${contextData.subconsciousClassification === 'CONVERSATIONAL' ? 'text-blue-400 bg-blue-900/20' : 'text-orange-400 bg-orange-900/20'}`}>
          Action Classification: {contextData.subconsciousClassification} {contextData.subconsciousClassification === 'TOOL_USE' ? '→ CLI spawn (planning cascade)' : '→ direct response (conversation cascade)'}
          {contextData.classifierDurationMs && (
            <span className="ml-2 font-normal text-gray-500">
              ({contextData.classifierDurationMs}ms{contextData.classifierUsage ? `, ${contextData.classifierUsage.input_tokens}→${contextData.classifierUsage.output_tokens} tok` : ''})
            </span>
          )}
        </div>
      )}
      {contextData.subconsciousEnabled && contextTab === 'conscious' && contextData.subconsciousError && (
        <p className="text-xs text-red-400 bg-red-900/20 rounded-lg px-3 py-2 mb-2">
          Subconscious processing failed: {contextData.subconsciousError} (fell back to raw context)
        </p>
      )}
      {contextData.subconsciousEnabled && contextTab === 'conscious' && (contextData.subconsciousContext || contextData.subconsciousOutput) && (
        <details className="mb-1" open>
          <summary className="text-xs font-semibold text-gray-400 cursor-pointer hover:text-gray-200 py-1.5 px-2 rounded bg-gray-700/30 hover:bg-gray-700/60 transition-colors">
            Curated Context{contextData.subconsciousDepthLabel ? ` — ${contextData.subconsciousDepthLabel}` : ''} ({((contextData.subconsciousContext || contextData.subconsciousOutput || '').length / 1024).toFixed(1)}K chars)
          </summary>
          <pre className="text-xs text-gray-300 bg-black/30 rounded-lg p-3 mt-1 mb-2 overflow-auto whitespace-pre-wrap break-words" style={{ maxHeight: 600 }}>
            {contextData.subconsciousContext || contextData.subconsciousOutput}
          </pre>
        </details>
      )}
      {contextData.subconsciousEnabled && contextTab === 'conscious' && contextData.subconsciousRecommendedResponse && (
        <details className="mb-1" open>
          <summary className={`text-xs font-semibold cursor-pointer hover:text-gray-200 py-1.5 px-2 rounded transition-colors ${!contextData.subconsciousRequiresToolUse ? 'text-green-400 bg-green-900/20 hover:bg-green-900/40' : 'text-orange-400 bg-orange-900/20 hover:bg-orange-900/40'}`}>
            Recommended Response {!contextData.subconsciousRequiresToolUse ? '(DIRECT — sent as final)' : '(discarded — TOOL_USE classified, CLI spawned)'}
          </summary>
          <pre className="text-xs text-gray-300 bg-black/30 rounded-lg p-3 mt-1 mb-2 overflow-auto whitespace-pre-wrap break-words" style={{ maxHeight: 400 }}>
            {contextData.subconsciousRecommendedResponse}
          </pre>
        </details>
      )}
      {contextData.imageDataUrls?.length > 0 && (
        <details className="mb-1" open>
          <summary className="text-xs font-semibold text-gray-400 cursor-pointer hover:text-gray-200 py-1.5 px-2 rounded bg-gray-700/30 hover:bg-gray-700/60 transition-colors">
            Images ({contextData.imageDataUrls.length})
            {contextData.images && ` \u2014 ${contextData.images.map(i => `${i.label}: ${i.sizeKB}KB`).join(', ')}`}
          </summary>
          <div className="flex gap-3 mt-2 mb-3 flex-wrap">
            {contextData.imageDataUrls.map((img, i) => (
              <div key={i} className="flex flex-col items-center">
                <img src={img.dataUrl} alt={img.label} className="rounded-lg border border-gray-600" style={{ maxHeight: 200, maxWidth: 250, objectFit: 'contain' }} />
                <span className="text-xs text-gray-500 mt-1">{img.label}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {(() => {
        const isConscious = contextData.subconsciousEnabled && contextTab === 'conscious';
        const structuralIdentity = (() => {
          if (!contextData.identityContext) return null;
          const lines = contextData.identityContext.split('\n');
          const result = [];
          let inAppearance = false;
          for (const line of lines) {
            if (inAppearance) {
              if (line.startsWith('-') || !line.trim()) { result.push(line); continue; }
              break;
            }
            result.push(line);
            if (/^## Appearance/.test(line)) inAppearance = true;
          }
          return result.join('\n').trim() || null;
        })();
        const principlesContent = (() => {
          if (!contextData.identityContext) return null;
          const match = contextData.identityContext.match(/<principles[^>]*>([\s\S]*?)<\/principles>/);
          return match ? match[1].trim() : null;
        })();
        const motivationsContent = (() => {
          if (!contextData.identityContext) return null;
          const match = contextData.identityContext.match(/<motivations[^>]*>([\s\S]*?)<\/motivations>/);
          return match ? match[1].trim() : null;
        })();
        const systemInstructionsContent = (() => {
          if (!contextData.identityContext) return null;
          const match = contextData.identityContext.match(/<system_instructions[^>]*>([\s\S]*?)<\/system_instructions>/);
          return match ? match[0].trim() : null;
        })();
        const identityWithoutInstructions = (() => {
          if (!contextData.identityContext || !systemInstructionsContent) return contextData.identityContext;
          return contextData.identityContext.replace(/<system_instructions[^>]*>[\s\S]*?<\/system_instructions>\s*/, '').trim();
        })();
        const allSections = [
          { title: 'Budget Profile', content: contextData.profile ? JSON.stringify(contextData.profile, null, 2) : null, raw: true },
          { title: 'System Instructions', content: systemInstructionsContent, raw: true },
          { title: 'Identity Context', content: identityWithoutInstructions, raw: true },
          { title: 'Identity (passthrough)', content: structuralIdentity, conscious: true },
          { title: 'Principles & Domain Syntheses', content: principlesContent },
          { title: 'Motivations', content: motivationsContent },
          { title: 'Memory - Raw Entries', content: contextData.memoryContext?.rawEntries
            ? `${contextData.memoryContext.rawEntries.length} entries\n\n` + contextData.memoryContext.rawEntries.map(e => `[${e.timestamp || ''}] ${e.speaker || e.role || ''}: ${e.content || ''}`).join('\n---\n')
            : null, raw: true },
          { title: 'Memory - Session Digests', content: contextData.memoryContext?.sessionDigests || contextData.memoryContext?.digestText, raw: true },
          { title: 'Memory - Daily Digests', content: contextData.memoryContext?.dailyDigests, raw: true },
          { title: 'Memory - Semantic Search', content: contextData.semanticMemoryText
            || (contextData.memoryContext?.relevantMemory?.length
              ? contextData.memoryContext.relevantMemory.map(c => `[${c.source || ''}] (score: ${c.score?.toFixed(3) || '?'})\n${c.text}`).join('\n---\n')
              : '(no semantic results for this message)'), raw: true },
          { title: 'Agent DMs', content: contextData.agentDMContext, raw: true },
          { title: 'Skills / Capabilities', content: contextData.skillContext },
        ];
        return (isConscious ? allSections.filter(s => !s.raw || s.conscious) : allSections.filter(s => !s.conscious));
      })().map((section, i) => {
        const text = section.content || ''
        const chars = text.length
        if (!text) return null
        return (
          <details key={i} className="mb-1">
            <summary className="text-xs font-semibold text-gray-400 cursor-pointer hover:text-gray-200 py-1.5 px-2 rounded bg-gray-700/30 hover:bg-gray-700/60 transition-colors">
              {section.title} ({(chars / 1024).toFixed(1)}K chars)
            </summary>
            <pre className="text-xs text-gray-300 bg-black/30 rounded-lg p-3 mt-1 mb-2 overflow-auto whitespace-pre-wrap break-words" style={{ maxHeight: 400 }}>
              {text}
            </pre>
          </details>
        )
      })}
    </>
  )
}

function AgentLifePanel({ contextData, contextTab, onTabChange, isLoading, activeTab, onActiveTabChange, baseApiUrl, appId, agentId, config, onConfigUpdated, onClose }) {
  return (
    <div className="h-full flex flex-col bg-gray-800/50 border-t border-gray-700">
      {/* Title bar */}
      <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-gray-700/50">
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">Agent Manager</span>
        <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">&times;</button>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-gray-700/50">
        <button
          className={`text-xs px-2.5 py-1 rounded transition-colors ${activeTab === 'myself' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/40'}`}
          onClick={() => onActiveTabChange('myself')}
        >Identity</button>
        <button
          className={`text-xs px-2.5 py-1 rounded transition-colors ${activeTab === 'motivations' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/40'}`}
          onClick={() => onActiveTabChange('motivations')}
        >Motivations</button>
        <button
          className={`text-xs px-2.5 py-1 rounded transition-colors ${activeTab === 'images' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/40'}`}
          onClick={() => onActiveTabChange('images')}
        >Images</button>
        <button
          className={`text-xs px-2.5 py-1 rounded transition-colors ${activeTab === 'items' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/40'}`}
          onClick={() => onActiveTabChange('items')}
        >Items</button>
        <button
          className={`text-xs px-2.5 py-1 rounded transition-colors ${activeTab === 'memory' ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/40'}`}
          onClick={() => onActiveTabChange('memory')}
        >Memory</button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {isLoading && activeTab === 'memory' && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="animate-pulse">Loading context...</span>
          </div>
        )}
        {!isLoading && !contextData && activeTab === 'memory' && (
          <p className="text-xs text-gray-500">Send a message to see memory context.</p>
        )}
        {!isLoading && contextData && activeTab === 'memory' && (
          <MemoryContent contextData={contextData} contextTab={contextTab} onTabChange={onTabChange} />
        )}
        {activeTab === 'myself' && (
          <AgentLifeMyself baseApiUrl={baseApiUrl} appId={appId} agentId={agentId} config={config} onConfigUpdated={onConfigUpdated} />
        )}
        {activeTab === 'images' && (
          <AgentLifeImages baseApiUrl={baseApiUrl} appId={appId} agentId={agentId} />
        )}
        {activeTab === 'items' && (
          <AgentLifeItems baseApiUrl={baseApiUrl} agentId={agentId} />
        )}
        {activeTab === 'motivations' && (
          <AgentLifeMotivations baseApiUrl={baseApiUrl} agentId={agentId} />
        )}
      </div>
    </div>
  )
}

export default AgentLifePanel
