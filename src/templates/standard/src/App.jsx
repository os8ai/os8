import { Routes, Route, Link } from 'react-router-dom'

// App configuration
const APP_NAME = '{{APP_NAME_JS}}'
const HEADER_COLOR = '{{COLOR}}'
const HEADER_TEXT_COLOR = '{{TEXT_COLOR}}'

function App() {
  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header
        className="shrink-0 shadow-md"
        style={{ backgroundColor: HEADER_COLOR }}
      >
        <div className="px-6 py-4">
          <Link
            to="/"
            className="text-xl font-semibold hover:opacity-80 transition-opacity"
            style={{ color: HEADER_TEXT_COLOR }}
          >
            {APP_NAME}
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-auto">
        <div className="bg-white min-h-full">
          <div className="px-6 py-8">
            <Routes>
              <Route path="/" element={<Home />} />
            </Routes>
          </div>
        </div>
      </main>
    </div>
  )
}

function Home() {
  return (
    <p className="text-gray-500">Your app is ready. Start building!</p>
  )
}

export default App
