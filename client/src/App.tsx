import { Routes, Route, Navigate } from "react-router-dom";
import Landing from "./pages/Landing";
import Studio from "./pages/Studio";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/studio" element={<Studio />} />
      <Route path="/studio/:jobId" element={<Studio />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
