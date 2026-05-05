import React from 'react';

export function App() {
  return (
    <main>
      <nav>
        <a href="/onboarding">Onboarding</a>
        <a href="/settings">Settings</a>
        <a href="/support">Support</a>
      </nav>
      <section>
        <h1>Workspace onboarding</h1>
        <p>Create a workspace, invite one collaborator, and finish the activation checklist.</p>
        <button>Start onboarding</button>
        <button>Continue after auth check</button>
      </section>
    </main>
  );
}
