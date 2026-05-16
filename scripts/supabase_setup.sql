-- ============================================
-- KISHOR EXPORTS EMAIL TRACKER — SUPABASE SQL
-- Run this in Supabase SQL Editor
-- ============================================

-- 1. EMAILS TABLE
CREATE TABLE IF NOT EXISTS emails (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email_id text UNIQUE NOT NULL,
  thread_id text,
  account text NOT NULL,
  source text NOT NULL DEFAULT 'outlook', -- 'outlook' or 'gmail'
  sender_name text,
  sender_email text,
  subject text,
  body_preview text,
  email_link text,
  received_at timestamptz,
  status text NOT NULL DEFAULT 'unreplied', -- 'unreplied', 'replied', 'system_generated'
  replied_at timestamptz,
  is_system_generated boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. USERS TABLE (for dashboard login)
CREATE TABLE IF NOT EXISTS users (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'agent', -- 'agent', 'manager', 'senior_manager'
  account_email text, -- the Gmail/Outlook address this user monitors
  manager_email text, -- who is their manager (for reports)
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 3. REMINDER LOGS TABLE (track what reminders were sent)
CREATE TABLE IF NOT EXISTS reminder_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type text NOT NULL, -- 'daily_agent', 'daily_manager', 'weekly'
  sent_to text NOT NULL,
  email_count integer DEFAULT 0,
  sent_at timestamptz DEFAULT now()
);

-- 4. INDEXES for performance
CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id);

-- 5. INSERT DEFAULT ADMIN USER (change password after first login!)
-- Password is: admin123 (bcrypt hash below)
INSERT INTO users (name, email, password_hash, role, account_email)
VALUES (
  'Admin',
  'admin@kishorexports.com',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- password: admin123
  'senior_manager',
  'hi@kishorexports.com'
) ON CONFLICT (email) DO NOTHING;

-- ============================================
-- DONE! Tables created successfully.
-- ============================================
