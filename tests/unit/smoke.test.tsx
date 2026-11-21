import { render, screen } from '@testing-library/react-native';

import Index from '../../app/index';

describe('root screen', () => {
  it('renders the root screen', async () => {
    await render(<Index />);
    expect(screen.getByText('Magora')).toBeTruthy();
  });
});
