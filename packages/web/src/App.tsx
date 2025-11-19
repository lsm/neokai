import Sidebar from "./islands/Sidebar.tsx";
import MainContent from "./islands/MainContent.tsx";
import ToastContainer from "./islands/ToastContainer.tsx";

export function App() {
  return (
    <>
      <div class="flex h-screen overflow-hidden bg-dark-950">
        {/* Sidebar */}
        <Sidebar />

        {/* Main Content */}
        <MainContent />
      </div>

      {/* Global Toast Container */}
      <ToastContainer />
    </>
  );
}
