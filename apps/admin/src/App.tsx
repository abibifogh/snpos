import { Routes, Route, Navigate } from 'react-router-dom';
import { Spinner } from '@snpos/ui';
import { useSession } from './session';
import { Login } from './pages/Login';
import { Shell } from './Shell';
import { Dashboard } from './pages/Dashboard';
import { SettingsPage } from './pages/SettingsPage';
import { CategoriesPage } from './pages/Categories';
import { MenuItemsPage } from './pages/MenuItems';
import { FeaturesPage } from './pages/Features';
import { VenuesPage } from './pages/Venues';

export function App() {
  const { user, loading } = useSession();

  if (loading) {
    return (
      <div className="login-wrap">
        <Spinner />
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/menu/categories" element={<CategoriesPage />} />
        <Route path="/menu/items" element={<MenuItemsPage />} />
        <Route path="/venues" element={<VenuesPage />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
