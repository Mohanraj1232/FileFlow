import { Routes, Route } from "react-router-dom";
import Layout from "./app/Layout";
import Dashboard from "./features/dashboard/Dashboard";
import RuleList from "./features/rules/RuleList";
import RuleBuilder from "./features/rules/RuleBuilder";
import Preview from "./features/preview/Preview";
import History from "./features/history/History";
import Unsorted from "./features/unsorted/Unsorted";
import Settings from "./features/settings/Settings";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/rules" element={<RuleList />} />
        <Route path="/rules/new" element={<RuleBuilder />} />
        <Route path="/rules/:id/edit" element={<RuleBuilder />} />
        <Route path="/preview" element={<Preview />} />
        <Route path="/preview/:folderId" element={<Preview />} />
        <Route path="/history" element={<History />} />
        <Route path="/unsorted" element={<Unsorted />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
