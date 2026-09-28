import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import TitleBar from "./TitleBar";

export default function Layout() {
  return (
    <div className="grid h-screen w-screen grid-cols-[250px_1fr] grid-rows-[40px_1fr] overflow-hidden bg-canvas">
      <div className="col-span-2">
        <TitleBar />
      </div>
      <Sidebar />
      <main className="overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
