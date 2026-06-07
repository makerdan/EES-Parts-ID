/**
 * Re-apply the section_num spatial fix for numeric aisles (13-22).
 *
 * Migration 0016_zone_section_num_fix.sql runs during `drizzle push` but its
 * UPDATE statements are no-ops when the production database is empty at deploy
 * time.  Run this script immediately after any bulk zone data load to ensure
 * the Map it! feature shows correct section numbers.
 *
 * Usage (from workspace root):
 *   DATABASE_URL="$PROD_DATABASE_URL" \
 *     pnpm --filter @workspace/api-server exec tsx src/scripts/apply-zone-section-fix.ts
 *
 * See docs/production-data-load.md for the full runbook.
 */

import { pool } from "@workspace/db";

async function applyZoneSectionFix() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Step 1: Negate all section_nums to clear the unique-index slots.
    const step1 = await client.query(`
      UPDATE warehouse_zone
      SET section_num = -section_num
      WHERE aisle_id ~ '^[0-9]+$'
    `);
    console.log(`Step 1 (negate): ${step1.rowCount} rows updated`);

    if ((step1.rowCount ?? 0) === 0) {
      console.warn(
        "WARNING: No rows matched in step 1. " +
        "Zone data may not be loaded yet — load zones first, then re-run this script."
      );
      await client.query("ROLLBACK");
      process.exit(1);
    }

    // Step 2: Assign correct section_nums from the spatial fix mapping.
    const step2 = await client.query(`
      UPDATE warehouse_zone
      SET section_num = CASE id
        WHEN 431 THEN 3
        WHEN 432 THEN 6
        WHEN 433 THEN 9
        WHEN 434 THEN 12
        WHEN 435 THEN 15
        WHEN 436 THEN 18
        WHEN 437 THEN 21
        WHEN 438 THEN 24
        WHEN 439 THEN 2
        WHEN 440 THEN 20
        WHEN 441 THEN 5
        WHEN 442 THEN 14
        WHEN 443 THEN 23
        WHEN 444 THEN 8
        WHEN 445 THEN 11
        WHEN 446 THEN 17
        WHEN 448 THEN 27
        WHEN 449 THEN 30
        WHEN 450 THEN 33
        WHEN 451 THEN 36
        WHEN 452 THEN 39
        WHEN 453 THEN 42
        WHEN 454 THEN 45
        WHEN 455 THEN 26
        WHEN 456 THEN 41
        WHEN 457 THEN 29
        WHEN 458 THEN 38
        WHEN 459 THEN 44
        WHEN 460 THEN 35
        WHEN 461 THEN 32
        WHEN 465 THEN 48
        WHEN 466 THEN 51
        WHEN 467 THEN 54
        WHEN 468 THEN 57
        WHEN 469 THEN 60
        WHEN 470 THEN 53
        WHEN 471 THEN 47
        WHEN 472 THEN 50
        WHEN 473 THEN 56
        WHEN 474 THEN 59
        WHEN 475 THEN 61
        WHEN 476 THEN 63
        WHEN 477 THEN 65
        WHEN 478 THEN 67
        WHEN 479 THEN 69
        WHEN 480 THEN 71
        WHEN 481 THEN 73
        WHEN 482 THEN 75
        WHEN 483 THEN 64
        WHEN 484 THEN 70
        WHEN 485 THEN 68
        WHEN 486 THEN 66
        WHEN 487 THEN 74
        WHEN 488 THEN 76
        WHEN 489 THEN 72
        WHEN 490 THEN 62
        WHEN 491 THEN 32
        WHEN 492 THEN 31
        WHEN 493 THEN 30
        WHEN 494 THEN 65
        WHEN 495 THEN 33
        WHEN 496 THEN 28
        WHEN 497 THEN 26
        WHEN 498 THEN 61
        WHEN 499 THEN 27
        WHEN 500 THEN 63
        WHEN 501 THEN 59
        WHEN 502 THEN 57
        WHEN 503 THEN 53
        WHEN 504 THEN 51
        WHEN 505 THEN 55
        WHEN 506 THEN 29
        WHEN 507 THEN 27
        WHEN 508 THEN 24
        WHEN 509 THEN 25
        WHEN 510 THEN 29
        WHEN 511 THEN 23
        WHEN 512 THEN 31
        WHEN 513 THEN 23
        WHEN 514 THEN 21
        WHEN 515 THEN 25
        WHEN 516 THEN 22
        WHEN 517 THEN 20
        WHEN 518 THEN 19
        WHEN 519 THEN 19
        WHEN 520 THEN 21
        WHEN 521 THEN 15
        WHEN 522 THEN 11
        WHEN 523 THEN 18
        WHEN 524 THEN 9
        WHEN 525 THEN 17
        WHEN 526 THEN 13
        WHEN 527 THEN 16
        WHEN 528 THEN 14
        WHEN 529 THEN 12
        WHEN 530 THEN 10
        WHEN 531 THEN 6
        WHEN 532 THEN 7
        WHEN 533 THEN 5
        WHEN 534 THEN 8
        WHEN 535 THEN 4
        WHEN 536 THEN 3
        WHEN 537 THEN 1
        WHEN 538 THEN 2
        WHEN 539 THEN 10
        WHEN 540 THEN 22
        WHEN 541 THEN 28
        WHEN 542 THEN 19
        WHEN 543 THEN 13
        WHEN 544 THEN 16
        WHEN 545 THEN 40
        WHEN 546 THEN 37
        WHEN 547 THEN 25
        WHEN 548 THEN 43
        WHEN 549 THEN 49
        WHEN 550 THEN 46
        WHEN 551 THEN 58
        WHEN 552 THEN 31
        WHEN 553 THEN 52
        WHEN 554 THEN 55
        WHEN 555 THEN 1
        WHEN 556 THEN 4
        WHEN 557 THEN 7
        WHEN 558 THEN 34
        WHEN 559 THEN 20
        WHEN 560 THEN 8
        WHEN 561 THEN 37
        WHEN 562 THEN 38
        WHEN 563 THEN 46
        WHEN 564 THEN 40
        WHEN 565 THEN 1
        WHEN 566 THEN 42
        WHEN 567 THEN 4
        WHEN 568 THEN 44
        WHEN 569 THEN 34
        WHEN 570 THEN 44
        WHEN 571 THEN 7
        WHEN 572 THEN 16
        WHEN 573 THEN 3
        WHEN 574 THEN 46
        WHEN 575 THEN 9
        WHEN 576 THEN 11
        WHEN 577 THEN 15
        WHEN 578 THEN 13
        WHEN 579 THEN 2
        WHEN 580 THEN 14
        WHEN 581 THEN 6
        WHEN 582 THEN 5
        WHEN 583 THEN 12
        WHEN 584 THEN 30
        WHEN 585 THEN 36
        WHEN 586 THEN 40
        WHEN 587 THEN 24
        WHEN 588 THEN 42
        WHEN 589 THEN 38
        WHEN 590 THEN 28
        WHEN 591 THEN 26
        WHEN 592 THEN 32
        WHEN 593 THEN 45
        WHEN 594 THEN 43
        WHEN 595 THEN 39
        WHEN 596 THEN 22
        WHEN 597 THEN 10
        WHEN 598 THEN 41
        WHEN 599 THEN 26
        WHEN 600 THEN 28
        WHEN 601 THEN 22
        WHEN 602 THEN 23
        WHEN 603 THEN 21
        WHEN 604 THEN 19
        WHEN 605 THEN 25
        WHEN 606 THEN 24
        WHEN 607 THEN 27
        WHEN 608 THEN 20
        WHEN 609 THEN 33
        WHEN 610 THEN 37
        WHEN 611 THEN 45
        WHEN 612 THEN 41
        WHEN 613 THEN 35
        WHEN 614 THEN 39
        WHEN 615 THEN 43
        WHEN 616 THEN 54
        WHEN 617 THEN 64
        WHEN 618 THEN 62
        WHEN 619 THEN 52
        WHEN 620 THEN 60
        WHEN 621 THEN 58
        WHEN 622 THEN 50
        WHEN 623 THEN 56
        WHEN 624 THEN 12
        WHEN 625 THEN 10
        WHEN 626 THEN 8
        WHEN 627 THEN 2
        WHEN 628 THEN 16
        WHEN 629 THEN 14
        WHEN 630 THEN 6
        WHEN 631 THEN 4
        WHEN 632 THEN 24
        WHEN 633 THEN 26
        WHEN 634 THEN 22
        WHEN 635 THEN 28
        WHEN 636 THEN 32
        WHEN 637 THEN 30
        WHEN 638 THEN 20
        WHEN 639 THEN 38
        WHEN 640 THEN 42
        WHEN 641 THEN 44
        WHEN 642 THEN 46
        WHEN 643 THEN 40
        WHEN 644 THEN 52
        WHEN 645 THEN 50
        WHEN 646 THEN 54
        WHEN 647 THEN 64
        WHEN 648 THEN 58
        WHEN 649 THEN 62
        WHEN 650 THEN 56
        WHEN 651 THEN 60
        WHEN 652 THEN 39
        WHEN 653 THEN 43
        WHEN 654 THEN 45
        WHEN 655 THEN 41
        WHEN 656 THEN 37
        WHEN 657 THEN 29
        WHEN 658 THEN 23
        WHEN 659 THEN 25
        WHEN 660 THEN 31
        WHEN 661 THEN 19
        WHEN 662 THEN 21
        WHEN 663 THEN 27
        WHEN 664 THEN 11
        WHEN 665 THEN 5
        WHEN 666 THEN 7
        WHEN 667 THEN 15
        WHEN 668 THEN 1
        WHEN 669 THEN 3
        WHEN 670 THEN 13
        WHEN 671 THEN 9
        WHEN 672 THEN 2
        WHEN 673 THEN 28
        WHEN 674 THEN 16
        WHEN 675 THEN 26
        WHEN 676 THEN 14
        WHEN 677 THEN 8
        WHEN 678 THEN 34
        WHEN 679 THEN 36
        WHEN 680 THEN 46
        WHEN 681 THEN 38
        WHEN 682 THEN 22
        WHEN 683 THEN 24
        WHEN 684 THEN 64
        WHEN 685 THEN 60
        WHEN 686 THEN 56
        WHEN 687 THEN 40
        WHEN 688 THEN 42
        WHEN 689 THEN 58
        WHEN 690 THEN 44
        WHEN 691 THEN 52
        WHEN 692 THEN 62
        WHEN 693 THEN 4
        WHEN 694 THEN 54
        WHEN 695 THEN 50
        WHEN 696 THEN 5
        WHEN 697 THEN 10
        WHEN 698 THEN 12
        WHEN 699 THEN 20
        WHEN 700 THEN 49
        WHEN 701 THEN 55
        WHEN 702 THEN 51
        WHEN 703 THEN 63
        WHEN 704 THEN 53
        WHEN 705 THEN 61
        WHEN 706 THEN 59
        WHEN 707 THEN 57
        WHEN 708 THEN 33
        WHEN 709 THEN 35
        WHEN 710 THEN 43
        WHEN 711 THEN 45
        WHEN 712 THEN 39
        WHEN 713 THEN 41
        WHEN 714 THEN 37
        WHEN 715 THEN 19
        WHEN 716 THEN 27
        WHEN 717 THEN 25
        WHEN 718 THEN 23
        WHEN 719 THEN 21
        WHEN 720 THEN 9
        WHEN 721 THEN 3
        WHEN 722 THEN 11
        WHEN 723 THEN 13
        WHEN 724 THEN 1
        WHEN 725 THEN 7
        WHEN 726 THEN 15
        WHEN 727 THEN 6
        WHEN 728 THEN 26
        WHEN 729 THEN 54
        WHEN 730 THEN 62
        WHEN 731 THEN 18
        WHEN 732 THEN 60
        WHEN 733 THEN 24
        WHEN 734 THEN 56
        WHEN 735 THEN 48
        WHEN 736 THEN 30
        WHEN 737 THEN 32
        WHEN 738 THEN 38
        WHEN 739 THEN 34
        WHEN 740 THEN 46
        WHEN 741 THEN 40
        WHEN 742 THEN 50
        WHEN 743 THEN 58
        WHEN 744 THEN 21
        WHEN 745 THEN 12
        WHEN 746 THEN 6
        WHEN 747 THEN 28
        WHEN 748 THEN 64
        WHEN 749 THEN 52
        WHEN 750 THEN 44
        WHEN 751 THEN 42
        WHEN 752 THEN 9
        WHEN 753 THEN 3
        WHEN 754 THEN 15
        WHEN 755 THEN 36
        WHEN 756 THEN 23
        WHEN 757 THEN 8
        WHEN 758 THEN 2
        WHEN 759 THEN 5
        WHEN 760 THEN 25
        WHEN 761 THEN 27
        WHEN 762 THEN 17
        WHEN 763 THEN 11
        WHEN 764 THEN 14
        WHEN 765 THEN 20
        WHEN 766 THEN 35
        WHEN 767 THEN 31
        WHEN 768 THEN 43
        WHEN 769 THEN 37
        WHEN 770 THEN 45
        WHEN 771 THEN 57
        WHEN 772 THEN 55
        WHEN 773 THEN 59
        WHEN 774 THEN 53
        WHEN 775 THEN 63
        WHEN 776 THEN 39
        WHEN 777 THEN 49
        WHEN 778 THEN 33
        WHEN 779 THEN 51
        WHEN 780 THEN 61
        WHEN 781 THEN 29
        WHEN 782 THEN 47
        WHEN 783 THEN 41
        WHEN 784 THEN 14
        WHEN 785 THEN 3
        WHEN 786 THEN 9
        WHEN 787 THEN 4
        WHEN 788 THEN 2
        WHEN 789 THEN 12
        WHEN 790 THEN 1
        WHEN 791 THEN 6
        WHEN 792 THEN 11
        WHEN 793 THEN 8
        WHEN 794 THEN 16
        WHEN 795 THEN 13
        WHEN 796 THEN 10
        WHEN 797 THEN 5
        WHEN 798 THEN 7
        WHEN 799 THEN 15
        WHEN 800 THEN 22
        WHEN 801 THEN 18
        WHEN 802 THEN 23
        WHEN 803 THEN 21
        WHEN 804 THEN 25
        WHEN 805 THEN 24
        WHEN 806 THEN 26
        WHEN 807 THEN 20
        WHEN 808 THEN 17
        WHEN 809 THEN 19
        WHEN 810 THEN 40
        WHEN 811 THEN 29
        WHEN 812 THEN 31
        WHEN 813 THEN 28
        WHEN 814 THEN 27
        WHEN 815 THEN 33
        WHEN 816 THEN 39
        WHEN 817 THEN 36
        WHEN 818 THEN 38
        WHEN 819 THEN 34
        WHEN 820 THEN 32
        WHEN 821 THEN 37
        WHEN 822 THEN 35
        WHEN 823 THEN 30
        WHEN 824 THEN 1
        WHEN 825 THEN 4
        WHEN 826 THEN 41
        WHEN 827 THEN 10
        WHEN 828 THEN 45
        WHEN 829 THEN 16
        WHEN 830 THEN 48
        WHEN 831 THEN 46
        WHEN 832 THEN 13
        WHEN 833 THEN 22
        WHEN 834 THEN 44
        WHEN 835 THEN 43
        WHEN 836 THEN 7
        WHEN 837 THEN 19
        WHEN 838 THEN 42
        WHEN 839 THEN 47
        WHEN 840 THEN 1
        WHEN 841 THEN 3
        WHEN 842 THEN 5
        WHEN 843 THEN 7
        WHEN 844 THEN 9
        WHEN 845 THEN 11
        WHEN 846 THEN 13
        WHEN 847 THEN 15
        WHEN 854 THEN 2
        WHEN 856 THEN 4
        WHEN 857 THEN 6
        WHEN 858 THEN 8
        WHEN 859 THEN 10
        WHEN 860 THEN 12
        WHEN 861 THEN 14
        WHEN 862 THEN 16
        WHEN 863 THEN 17
        WHEN 864 THEN 18
        WHEN 865 THEN 19
        WHEN 866 THEN 20
        WHEN 867 THEN 21
        WHEN 868 THEN 22
        WHEN 869 THEN 24
        WHEN 870 THEN 23
        WHEN 871 THEN 25
        WHEN 872 THEN 26
        WHEN 873 THEN 27
        WHEN 874 THEN 28
        WHEN 875 THEN 29
        WHEN 876 THEN 30
        WHEN 877 THEN 31
        WHEN 878 THEN 32
        WHEN 879 THEN 33
        WHEN 880 THEN 34
        WHEN 881 THEN 50
        WHEN 882 THEN 48
        WHEN 883 THEN 41
        WHEN 884 THEN 46
        WHEN 885 THEN 51
        WHEN 886 THEN 45
        WHEN 887 THEN 53
        WHEN 888 THEN 43
        WHEN 889 THEN 55
        WHEN 890 THEN 54
        WHEN 891 THEN 52
        WHEN 892 THEN 49
        WHEN 893 THEN 47
        WHEN 894 THEN 44
        WHEN 895 THEN 42
        WHEN 896 THEN 40
        WHEN 897 THEN 38
        WHEN 898 THEN 36
        WHEN 899 THEN 34
        WHEN 900 THEN 33
        WHEN 901 THEN 31
        WHEN 902 THEN 29
        WHEN 903 THEN 27
        WHEN 904 THEN 26
        WHEN 905 THEN 25
        WHEN 906 THEN 21
        WHEN 907 THEN 19
        WHEN 908 THEN 17
        WHEN 909 THEN 16
        WHEN 910 THEN 14
        WHEN 911 THEN 11
        WHEN 912 THEN 9
        WHEN 913 THEN 7
        WHEN 914 THEN 4
        WHEN 915 THEN 3
        WHEN 916 THEN 2
        WHEN 917 THEN 1
        WHEN 918 THEN 37
        WHEN 919 THEN 28
        WHEN 920 THEN 30
        WHEN 921 THEN 39
        WHEN 922 THEN 32
        WHEN 923 THEN 35
        WHEN 924 THEN 20
        WHEN 925 THEN 22
        WHEN 926 THEN 24
        WHEN 927 THEN 23
        WHEN 928 THEN 18
        WHEN 929 THEN 15
        WHEN 930 THEN 13
        WHEN 931 THEN 10
        WHEN 932 THEN 12
        WHEN 933 THEN 6
        WHEN 934 THEN 8
        WHEN 935 THEN 5
        ELSE section_num
      END
      WHERE aisle_id ~ '^[0-9]+$'
    `);
    console.log(`Step 2 (assign): ${step2.rowCount} rows updated`);

    await client.query("COMMIT");
    console.log("Zone section_num fix applied successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Fix failed — transaction rolled back:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

applyZoneSectionFix().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
