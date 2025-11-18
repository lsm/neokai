import { define } from "../utils.ts";
import Sidebar from "../islands/Sidebar.tsx";
import MainContent from "../islands/MainContent.tsx";
import ToastContainer from "../islands/ToastContainer.tsx";

export default define.page(function Home() {
  return (
    <>
      <div class="flex h-screen overflow-hidden bg-dark-950">
        {/* Sidebar */}
        <Sidebar />

        {/* Main Content - Now a reactive island */}
        <MainContent />
      </div>

      {/* Global Toast Container */}
      <ToastContainer />
    </>
  );
});
