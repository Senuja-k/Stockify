import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export default function PrivacyPolicy() {
  const effectiveDate = "March 4, 2026";
  const appUrl = "https://stockify-virid.vercel.app";
  const contactEmail = "senujakmk@gmail.com";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-slate-200">
      <div className="max-w-3xl mx-auto px-4 py-12">
        {/* Back link */}
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors mb-8"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Login
        </Link>

        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-8 md:p-10 space-y-8">
          <header className="space-y-2">
            <h1 className="text-3xl font-bold text-white">Privacy Policy</h1>
            <p className="text-sm text-slate-400">
              Effective date: {effectiveDate}
            </p>
          </header>

          {/* 1 – Introduction */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              1. Introduction
            </h2>
            <p>
              Stockify (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;)
              operates the web application at{" "}
              <a
                href={appUrl}
                className="text-blue-400 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                {appUrl}
              </a>
              . This Privacy Policy explains how we collect, use, disclose, and
              safeguard your information when you use our Shopify application and
              related services.
            </p>
          </section>

          {/* 2 – Information We Collect */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              2. Information We Collect
            </h2>

            <h3 className="font-medium text-slate-300">
              2.1 Information You Provide
            </h3>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                Account credentials (email address and password) when you sign
                up or log in.
              </li>
              <li>
                Shopify store domain name when you connect a store.
              </li>
            </ul>

            <h3 className="font-medium text-slate-300">
              2.2 Information from Shopify
            </h3>
            <p>
              When you authorize Stockify through Shopify OAuth, we access and
              store the following data from your Shopify store:
            </p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>Product information (titles, descriptions, variants, prices, inventory levels, images, tags, vendors, product types, and status).</li>
              <li>Store metadata (shop name, domain).</li>
            </ul>
            <p>
              We only request the minimum Shopify API scopes required to provide
              our product reporting features. We do <strong>not</strong> access
              customer data, orders, or payment information.
            </p>

            <h3 className="font-medium text-slate-300">
              2.3 Automatically Collected Information
            </h3>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>Browser type, device type, and operating system.</li>
              <li>Pages viewed within the application and usage timestamps.</li>
              <li>IP address (stored only in server logs).</li>
            </ul>
          </section>

          {/* 3 – How We Use Your Information */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              3. How We Use Your Information
            </h2>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>To provide, operate, and maintain the Stockify application.</li>
              <li>To sync and display your Shopify product data in reports and dashboards.</li>
              <li>To authenticate your identity and protect your account.</li>
              <li>To improve the application and develop new features.</li>
              <li>To communicate with you regarding service updates or support.</li>
            </ul>
          </section>

          {/* 4 – Data Storage & Security */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              4. Data Storage &amp; Security
            </h2>
            <p>
              Your data is stored securely using{" "}
              <a
                href="https://supabase.com"
                className="text-blue-400 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Supabase
              </a>{" "}
              (hosted on AWS infrastructure) with row-level security policies.
              All data is transmitted over HTTPS/TLS encryption.
            </p>
            <p>
              While we implement industry-standard security measures, no method
              of electronic storage is 100% secure. We cannot guarantee absolute
              security but take all reasonable precautions to protect your data.
            </p>
          </section>

          {/* 5 – Data Sharing & Disclosure */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              5. Data Sharing &amp; Disclosure
            </h2>
            <p>We do <strong>not</strong> sell your personal data. We may share information only in the following circumstances:</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>
                <strong>Service providers:</strong> Third-party services that
                help us operate the application (e.g., Supabase for database
                hosting, Vercel for application hosting).
              </li>
              <li>
                <strong>Legal requirements:</strong> When required by law,
                regulation, or legal process.
              </li>
              <li>
                <strong>Public reports:</strong> If you choose to generate a
                public share link for a report, the product data included in
                that report will be accessible to anyone with the link.
              </li>
            </ul>
          </section>

          {/* 6 – Data Retention & Deletion */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              6. Data Retention &amp; Deletion
            </h2>
            <p>
              We retain your data for as long as your account is active. You may
              request deletion of your account and all associated data at any
              time by contacting us at{" "}
              <a
                href={`mailto:${contactEmail}`}
                className="text-blue-400 hover:underline"
              >
                {contactEmail}
              </a>
              . Upon receiving a verified deletion request, we will remove your
              data within 30 days.
            </p>
            <p>
              If you uninstall the Stockify app from your Shopify store, we will
              delete all synced product data associated with that store within
              30 days.
            </p>
          </section>

          {/* 7 – Your Rights */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              7. Your Rights
            </h2>
            <p>Depending on your jurisdiction, you may have the right to:</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>Access the personal data we hold about you.</li>
              <li>Request correction of inaccurate data.</li>
              <li>Request deletion of your data.</li>
              <li>Object to or restrict certain processing of your data.</li>
              <li>Data portability (receive your data in a structured format).</li>
            </ul>
            <p>
              To exercise any of these rights, please contact us at{" "}
              <a
                href={`mailto:${contactEmail}`}
                className="text-blue-400 hover:underline"
              >
                {contactEmail}
              </a>
              .
            </p>
          </section>

          {/* 8 – Cookies */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              8. Cookies &amp; Local Storage
            </h2>
            <p>
              Stockify uses browser local storage and session storage solely to
              maintain your authentication session and user preferences. We do
              not use third-party tracking cookies or advertising cookies.
            </p>
          </section>

          {/* 9 – Children's Privacy */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              9. Children&apos;s Privacy
            </h2>
            <p>
              Stockify is not intended for use by individuals under the age of
              16. We do not knowingly collect personal information from children.
            </p>
          </section>

          {/* 10 – Changes */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              10. Changes to This Policy
            </h2>
            <p>
              We may update this Privacy Policy from time to time. We will
              notify you of material changes by posting the updated policy on
              this page and updating the effective date above.
            </p>
          </section>

          {/* 11 – Contact */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white">
              11. Contact Us
            </h2>
            <p>
              If you have questions about this Privacy Policy, please contact us
              at{" "}
              <a
                href={`mailto:${contactEmail}`}
                className="text-blue-400 hover:underline"
              >
                {contactEmail}
              </a>
              .
            </p>
          </section>
        </div>

        <p className="text-center text-xs text-slate-500 mt-8">
          &copy; {new Date().getFullYear()} Stockify. All rights reserved.
        </p>
      </div>
    </div>
  );
}
