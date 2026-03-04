import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/authStore.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { Store, Loader2, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [shopifyShop, setShopifyShop] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSignup, setIsSignup] = useState(false);
  // Removed unused emailSent state
  const navigate = useNavigate();
  const login = useAuth((state) => state.login);
  const signup = useAuth((state) => state.signup);
  const initiateShopifyLogin = useAuth((state) => state.initiateShopifyLogin);
  const authIsLoading = useAuth((state) => state.isLoading);

  // Sync local isLoading with Zustand auth store's isLoading
  useEffect(() => {
    setIsLoading(authIsLoading);
  }, [authIsLoading]);

  // Reset loading state when component unmounts to prevent stuck state
  useEffect(() => {
    return () => {
      
      setIsLoading(false);
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    setIsLoading(true);

    try {
      if (isSignup) {
        
        if (password !== confirmPassword) {
          toast({
            title: 'Passwords do not match',
            description: 'Please enter the same password twice',
            variant: 'destructive',
          });
          setIsLoading(false);
          return;
        }

        
        await signup(email, password);
        
        toast({
          title: 'Account created',
          description: 'Welcome to Stockify',
        });
        navigate('/');
        setIsLoading(false);
        return;
      }
      // Login flow for non-signup
      await login(email, password);
      toast({
        title: 'Login successful',
        description: 'Welcome back to Stockify',
      });
      navigate('/');
      setIsLoading(false);
    } catch (error) {
      console.error('[Login] Error during', isSignup ? 'signup' : 'login', ':', error);
      toast({
        title: isSignup ? 'Signup failed' : 'Login failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      });
      setIsLoading(false);
    }
  };

  const toggleMode = () => {
    setIsSignup(!isSignup);
    setEmail('');
    setPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <div className="text-center">
            <img src="/logo-256.png" alt="Stockify" className="mx-auto mb-3 h-48 w-auto object-contain" />
          </div>
          <CardDescription className="text-center">
          </CardDescription>
        </CardHeader>
        
        <CardContent>
          {isSignup ? (
            <>
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Signup Form (no email confirmation) */}
                <div className="space-y-4 py-2">
                  <div className="text-center">
                    <Mail className="h-12 w-12 text-blue-600 mx-auto mb-3" />
                    <h3 className="font-semibold mb-1">Create Your Account</h3>
                    <p className="text-sm text-muted-foreground">
                      Enter your email and password to create your account.
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isLoading}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isLoading}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirm Password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={isLoading}
                    required
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Creating account...
                    </>
                  ) : (
                    'Sign Up'
                  )}
                </Button>
              </form>

              <div className="mt-4 text-center">
                <p className="text-sm text-slate-600">
                  Already have an account?{' '}
                  <button
                    onClick={toggleMode}
                    className="text-blue-600 hover:underline font-medium"
                    disabled={isLoading}
                  >
                    Sign in
                  </button>
                </p>
              </div>
            </>
          ) : (
            <>
              {/* Email/Password Login */}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isLoading}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isLoading}
                    required
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={isLoading}
                >
                  {isLoading ? 'Signing in...' : 'Sign In'}
                </Button>
              </form>

              <div className="mt-6 text-center">
                <p className="text-sm text-slate-600">
                  Don't have an account?{' '}
                  <button
                    onClick={toggleMode}
                    className="text-blue-600 hover:underline font-medium"
                    disabled={isLoading}
                  >
                    Sign up
                  </button>
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-center text-xs text-slate-400">
        <Link to="/privacy-policy" className="hover:text-white hover:underline transition-colors">
          Privacy Policy
        </Link>
      </p>
    </div>
  );
}
