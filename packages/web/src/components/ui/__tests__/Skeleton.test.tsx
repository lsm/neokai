/**
 * Tests for Skeleton Components
 */

import './setup'; // Setup Happy-DOM
import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/preact';
import { Skeleton, SkeletonText, SkeletonMessage, SkeletonSession } from '../Skeleton';

describe('Skeleton', () => {
	describe('Variants', () => {
		it('should render text variant by default', () => {
			const { container } = render(<Skeleton />);
			const skeleton = container.querySelector('.skeleton');
			expect(skeleton?.className).toContain('rounded');
			expect(skeleton?.className).toContain('h-4');
		});

		it('should render circle variant', () => {
			const { container } = render(<Skeleton variant="circle" />);
			const skeleton = container.querySelector('.skeleton');
			expect(skeleton?.className).toContain('rounded-full');
		});

		it('should render rectangle variant', () => {
			const { container } = render(<Skeleton variant="rectangle" />);
			const skeleton = container.querySelector('.skeleton');
			expect(skeleton?.className).toContain('rounded-lg');
		});
	});

	describe('Sizing', () => {
		it('should apply width as number', () => {
			const { container } = render(<Skeleton width={100} />);
			const skeleton = container.querySelector('.skeleton') as HTMLElement;
			expect(skeleton?.style.width).toBe('100px');
		});

		it('should apply width as string', () => {
			const { container } = render(<Skeleton width="50%" />);
			const skeleton = container.querySelector('.skeleton') as HTMLElement;
			expect(skeleton?.style.width).toBe('50%');
		});

		it('should apply height as number', () => {
			const { container } = render(<Skeleton height={50} />);
			const skeleton = container.querySelector('.skeleton') as HTMLElement;
			expect(skeleton?.style.height).toBe('50px');
		});

		it('should apply height as string', () => {
			const { container } = render(<Skeleton height="2rem" />);
			const skeleton = container.querySelector('.skeleton') as HTMLElement;
			expect(skeleton?.style.height).toBe('2rem');
		});

		it('should apply both width and height', () => {
			const { container } = render(<Skeleton width={100} height={50} />);
			const skeleton = container.querySelector('.skeleton') as HTMLElement;
			expect(skeleton?.style.width).toBe('100px');
			expect(skeleton?.style.height).toBe('50px');
		});
	});

	describe('Custom Styling', () => {
		it('should apply custom className', () => {
			const { container } = render(<Skeleton class="custom-skeleton" />);
			const skeleton = container.querySelector('.skeleton');
			expect(skeleton?.className).toContain('custom-skeleton');
		});

		it('should merge custom className with variant classes', () => {
			const { container } = render(<Skeleton variant="circle" class="custom" />);
			const skeleton = container.querySelector('.skeleton');
			expect(skeleton?.className).toContain('rounded-full');
			expect(skeleton?.className).toContain('custom');
		});
	});
});

describe('SkeletonText', () => {
	it('should render 3 lines by default', () => {
		const { container } = render(<SkeletonText />);
		const skeletons = container.querySelectorAll('.skeleton');
		expect(skeletons.length).toBe(3);
	});

	it('should render custom number of lines', () => {
		const { container } = render(<SkeletonText lines={5} />);
		const skeletons = container.querySelectorAll('.skeleton');
		expect(skeletons.length).toBe(5);
	});

	it('should render last line shorter than others', () => {
		const { container } = render(<SkeletonText lines={2} />);
		const skeletons = container.querySelectorAll('.skeleton');
		const lastSkeleton = skeletons[skeletons.length - 1] as HTMLElement;

		expect(lastSkeleton.style.width).toBe('60%');
	});

	it('should render full width for non-last lines', () => {
		const { container } = render(<SkeletonText lines={3} />);
		const skeletons = container.querySelectorAll('.skeleton');
		const firstSkeleton = skeletons[0] as HTMLElement;
		const secondSkeleton = skeletons[1] as HTMLElement;

		expect(firstSkeleton.style.width).toBe('100%');
		expect(secondSkeleton.style.width).toBe('100%');
	});

	it('should render with spacing between lines', () => {
		const { container } = render(<SkeletonText />);
		const wrapper = container.querySelector('.space-y-3');
		expect(wrapper).toBeTruthy();
	});
});

describe('SkeletonMessage', () => {
	it('should render avatar skeleton', () => {
		const { container } = render(<SkeletonMessage />);
		const skeletons = container.querySelectorAll('.skeleton');

		// Should have circle avatar + title + text lines
		const circleSkeletons = Array.from(skeletons).filter((el) =>
			el.className.includes('rounded-full')
		);
		expect(circleSkeletons.length).toBeGreaterThan(0);
	});

	it('should render with flex layout', () => {
		const { container } = render(<SkeletonMessage />);
		const wrapper = container.querySelector('.flex.gap-3');
		expect(wrapper).toBeTruthy();
	});

	it('should render title and text skeletons', () => {
		const { container } = render(<SkeletonMessage />);
		const skeletons = container.querySelectorAll('.skeleton');

		// Avatar (1) + Title (1) + Text lines (2) = 4 total
		expect(skeletons.length).toBeGreaterThanOrEqual(3);
	});

	it('should render avatar with fixed size', () => {
		const { container } = render(<SkeletonMessage />);
		const skeletons = container.querySelectorAll('.skeleton');
		const avatar = Array.from(skeletons).find((el) =>
			el.className.includes('rounded-full')
		) as HTMLElement;

		expect(avatar?.style.width).toBe('40px');
		expect(avatar?.style.height).toBe('40px');
	});
});

describe('SkeletonSession', () => {
	it('should render title and subtitle skeletons', () => {
		const { container } = render(<SkeletonSession />);
		const skeletons = container.querySelectorAll('.skeleton');
		expect(skeletons.length).toBe(2);
	});

	it('should render with padding and spacing', () => {
		const { container } = render(<SkeletonSession />);
		const wrapper = container.querySelector('.p-3.space-y-2');
		expect(wrapper).toBeTruthy();
	});

	it('should render title wider than subtitle', () => {
		const { container } = render(<SkeletonSession />);
		const skeletons = container.querySelectorAll('.skeleton');
		const title = skeletons[0] as HTMLElement;
		const subtitle = skeletons[1] as HTMLElement;

		expect(title.style.width).toBe('80%');
		expect(subtitle.style.width).toBe('40%');
	});

	it('should render different heights for title and subtitle', () => {
		const { container } = render(<SkeletonSession />);
		const skeletons = container.querySelectorAll('.skeleton');
		const title = skeletons[0] as HTMLElement;
		const subtitle = skeletons[1] as HTMLElement;

		expect(title.style.height).toBe('18px');
		expect(subtitle.style.height).toBe('14px');
	});
});

describe('Skeleton Edge Cases', () => {
	it('should handle zero width', () => {
		const { container } = render(<Skeleton width={0} />);
		const skeleton = container.querySelector('.skeleton') as HTMLElement;
		// Zero width is rendered as "0px" or empty string depending on implementation
		expect(skeleton?.style.width === '0px' || skeleton?.style.width === '').toBe(true);
	});

	it('should handle zero height', () => {
		const { container } = render(<Skeleton height={0} />);
		const skeleton = container.querySelector('.skeleton') as HTMLElement;
		// Zero height is rendered as "0px" or empty string depending on implementation
		expect(skeleton?.style.height === '0px' || skeleton?.style.height === '').toBe(true);
	});

	it('should handle very large dimensions', () => {
		const { container } = render(<Skeleton width={9999} height={9999} />);
		const skeleton = container.querySelector('.skeleton') as HTMLElement;
		expect(skeleton?.style.width).toBe('9999px');
		expect(skeleton?.style.height).toBe('9999px');
	});

	it('should handle complex width strings', () => {
		const { container } = render(<Skeleton width="calc(100% - 20px)" />);
		const skeleton = container.querySelector('.skeleton') as HTMLElement;
		expect(skeleton?.style.width).toBe('calc(100% - 20px)');
	});
});

describe('SkeletonText Edge Cases', () => {
	it('should handle 1 line', () => {
		const { container } = render(<SkeletonText lines={1} />);
		const skeletons = container.querySelectorAll('.skeleton');
		expect(skeletons.length).toBe(1);
	});

	it('should handle 0 lines', () => {
		const { container } = render(<SkeletonText lines={0} />);
		const skeletons = container.querySelectorAll('.skeleton');
		expect(skeletons.length).toBe(0);
	});

	it('should handle many lines', () => {
		const { container } = render(<SkeletonText lines={20} />);
		const skeletons = container.querySelectorAll('.skeleton');
		expect(skeletons.length).toBe(20);
	});
});
