import Link from "next/link";
import { Brand } from "./brand";

const features = [
  [
    "M5 4h14v16H5z M5 9h14 M9 2v4 M15 2v4 M9 12h2 M14 12h2 M9 16h2 M14 16h2",
    "Easy Employee Scheduling",
    "Build, copy, edit, and publish weekly schedules. Keep drafts private until you’re ready to share.",
  ],
  [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
    "Time-Off Management",
    "Give employees a simple way to ask for time off, and managers a clear place to review requests.",
  ],
  [
    "M4 7h15 M15 3l4 4-4 4 M20 17H5 M9 13l-4 4 4 4",
    "Shift Coverage & Swaps",
    "Coordinate coverage and shift exchanges with coworker consent and the right approvals.",
  ],
  [
    "M6 9a6 6 0 0 1 12 0v5l2 3H4l2-3z M10 20h4",
    "Team Notifications",
    "Keep your team informed about schedule changes and request decisions, with preferences they control.",
  ],
  [
    "M5 4h14v16H5z M5 9h14 M9 2v4 M15 2v4 M9 14l2 2 4-4",
    "Calendar Integration",
    "Subscribe to published shifts in compatible Apple, Google, or Outlook calendars when your workplace enables calendar subscriptions.",
  ],
  [
    "M9 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M3 20v-3a6 6 0 0 1 12 0v3 M17 4a3 3 0 0 1 0 6 M18 13a5 5 0 0 1 3 5v2",
    "Employee Management",
    "Invite your team, manage workplace roles, and keep an organized employee roster.",
  ],
];
export function MarketingHome({ signedIn = false }: { signedIn?: boolean }) {
  const start = signedIn ? "/workspaces" : "/signup?next=%2Fonboarding";
  const label = signedIn ? "Open Meadowmark" : "Get Started";
  return (
    <div className="marketing">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="public-header">
        <Link className="brand" href="/" aria-label="Meadowmark home">
          <Brand />
        </Link>
        <nav className="public-desktop" aria-label="Public navigation">
          <a href="#features">Features</a>
          <a href="#how-it-works">How It Works</a>
          <Link href={signedIn ? "/workspaces" : "/login"}>
            {signedIn ? "Go to Dashboard" : "Sign In"}
          </Link>
          <Link className="button primary" href={start}>
            {label} <span aria-hidden="true">→</span>
          </Link>
        </nav>
        <details className="public-mobile">
          <summary>Menu</summary>
          <nav aria-label="Mobile public navigation">
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <Link href={signedIn ? "/workspaces" : "/login"}>
              {signedIn ? "Go to Dashboard" : "Sign In"}
            </Link>
            <Link href={start}>{label}</Link>
          </nav>
        </details>
      </header>
      <main id="main-content">
        <section className="marketing-hero">
          <div className="hero-copy">
            <p className="marketing-kicker">
              <span aria-hidden="true">✳</span> A little more room to grow
            </p>
            <h1>
              Less time scheduling.
              <br />
              <em>More time running your business.</em>
            </h1>
            <p className="hero-description">
              Create schedules, manage time off, coordinate shift coverage, and
              keep your entire team on the same page — all in one simple place.
            </p>
            <div className="marketing-actions">
              <Link className="button primary" href={start}>
                {label} <span aria-hidden="true">→</span>
              </Link>
              <a className="button secondary" href="#features">
                Explore Features
              </a>
            </div>
            <p className="hero-note">
              Built for small businesses. Made for real people.
            </p>
          </div>
          <div
            className="product-preview"
            aria-label="Illustrative weekly schedule preview with sample data"
          >
            <div className="preview-top">
              <span className="preview-mark">M</span>
              <strong>The Meadow Café</strong>
              <span className="preview-pill">Sample workspace</span>
            </div>
            <div className="preview-heading">
              <div>
                <small>YOUR WEEK, AT A GLANCE</small>
                <h2>A good week starts here.</h2>
              </div>
              <span className="preview-pill">Published ✓</span>
            </div>
            <div className="preview-calendar">
              {["Mon", "Tue", "Wed"].map((day, i) => (
                <div key={day}>
                  <p>
                    {day} <strong>{9 + i}</strong>
                  </p>
                  <article>
                    <span>Morning</span>
                    <strong>8:00 AM – 2:00 PM</strong>
                    <small>Team member A</small>
                  </article>
                  <article className="preview-evening">
                    <span>Afternoon</span>
                    <strong>2:00 PM – 8:00 PM</strong>
                    <small>Team member B</small>
                  </article>
                </div>
              ))}
            </div>
            <div className="preview-bottom">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>Everyone on the same page.</strong>
                <small>Published shifts, ready for your team.</small>
              </div>
            </div>
            <p className="preview-caption">
              Illustrative preview · sample data
            </p>
          </div>
        </section>
        <div className="marketing-ribbon">
          Less back-and-forth. <span>More clarity for every shift.</span>
        </div>
        <section id="features" className="marketing-section">
          <div className="section-intro">
            <p className="marketing-kicker">THE EVERYDAY, SIMPLIFIED</p>
            <h2>
              Everything your team needs.
              <br />
              <em>Room to focus on what matters.</em>
            </h2>
            <p>
              From the first draft to the last shift, keep the details together.
            </p>
          </div>
          <div className="feature-grid">
            {features.map(([icon, title, text]) => (
              <article className="feature-card" key={title}>
                <span className="feature-icon" aria-hidden="true">
                  <svg
                    width="23"
                    height="23"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={icon} />
                  </svg>
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>
        <section id="how-it-works" className="marketing-section how-section">
          <div className="section-intro">
            <p className="marketing-kicker">A SIMPLE START</p>
            <h2>
              Your workplace.
              <br />
              <em>Up and running.</em>
            </h2>
            <p>
              Start small, explore at your own pace, and publish when you’re
              ready.
            </p>
          </div>
          <ol className="steps-grid">
            {[
              [
                "Create Your Workplace",
                "Set up your business and choose its scheduling time zone.",
              ],
              [
                "Invite Your Team",
                "Add employees to your roster and invite them when you’re ready.",
              ],
              [
                "Start Scheduling",
                "Build and publish schedules, manage requests, and stay organized.",
              ],
            ].map(([title, text], i) => (
              <li key={title}>
                <span className="step-number">0{i + 1}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </section>
        <section className="marketing-section simple-section">
          <div className="simple-illustration" aria-hidden="true">
            <span>✳</span>
            <p>
              A calmer way
              <br />
              to plan your week.
            </p>
          </div>
          <div>
            <p className="marketing-kicker">SMALL BUSINESS. BIG HEART.</p>
            <h2>
              Less to figure out.
              <br />
              <em>More to look forward to.</em>
            </h2>
            <p>
              You have a business to run and people to look after. Meadowmark
              brings scheduling, requests, and team updates into one
              approachable place, so the day-to-day feels a little lighter.
            </p>
            <Link href="/demo">
              Explore the interactive demo <span aria-hidden="true">→</span>
            </Link>
            <small className="demo-disclaimer">
              Sample data only. Demo changes aren’t saved.
            </small>
          </div>
        </section>
        <section className="marketing-cta">
          <p className="marketing-kicker">LET’S MAKE ROOM FOR A BETTER WEEK</p>
          <h2>
            Your next chapter starts
            <br />
            with a simpler schedule.
          </h2>
          <Link className="button primary" href={start}>
            {label} <span aria-hidden="true">→</span>
          </Link>
        </section>
      </main>
      <footer className="public-footer">
        <Link className="brand" href="/">
          <Brand />
        </Link>
        <p>Simple scheduling. A little more breathing room.</p>
        <nav aria-label="Footer navigation">
          <a href="#features">Features</a>
          <a href="#how-it-works">How It Works</a>
          <Link href={signedIn ? "/workspaces" : "/login"}>
            {signedIn ? "Open Meadowmark" : "Sign In"}
          </Link>
        </nav>
      </footer>
    </div>
  );
}
